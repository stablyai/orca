// Why: extracted from worktrees.ts to keep the main IPC module under the
// max-lines threshold. Worktree creation helpers (local and remote) live
// here so the IPC dispatch file stays focused on handler wiring.

import type { BrowserWindow } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import type { Store } from '../persistence'
import type {
  CreateWorktreeArgs,
  CreateWorktreeResult,
  Repo,
  WorktreeMeta
} from '../../shared/types'
import { getPRForBranch } from '../github/client'
import { listWorktrees, addWorktree } from '../git/worktree'
import { getGitUsername, getDefaultBaseRef, getBranchConflictKind } from '../git/repo'
import { gitExecFileAsync } from '../git/runner'
import { isWslPath, parseWslPath, getWslHome } from '../wsl'
import { createSetupRunnerScript, getEffectiveHooks, shouldRunSetupForCreate } from '../hooks'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import { getActiveMultiplexer } from './ssh'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import {
  sanitizeWorktreeName,
  computeBranchName,
  computeWorktreePath,
  ensurePathWithinWorkspace,
  shouldSetDisplayName,
  mergeWorktree,
  areWorktreePathsEqual
} from './worktree-logic'
import { invalidateAuthorizedRootsCache } from './filesystem-auth'

export function notifyWorktreesChanged(mainWindow: BrowserWindow, repoId: string): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('worktrees:changed', { repoId })
  }
}

export async function createRemoteWorktree(
  args: CreateWorktreeArgs,
  repo: Repo,
  store: Store,
  mainWindow: BrowserWindow
): Promise<CreateWorktreeResult> {
  const provider = getSshGitProvider(repo.connectionId!) as SshGitProvider | undefined
  if (!provider) {
    throw new Error(`No git provider for connection "${repo.connectionId}"`)
  }

  const settings = store.getSettings()
  const requestedName = args.name
  const sanitizedName = sanitizeWorktreeName(args.name)

  // Get git username from remote
  let username = ''
  try {
    const { stdout } = await provider.exec(['config', 'user.name'], repo.path)
    username = stdout.trim()
  } catch {
    /* no username configured */
  }

  const branchName = computeBranchName(sanitizedName, settings, username)

  // Check branch conflict on remote
  try {
    const { stdout } = await provider.exec(['branch', '--list', '--all', branchName], repo.path)
    if (stdout.trim()) {
      throw new Error(`Branch "${branchName}" already exists. Pick a different worktree name.`)
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('already exists')) {
      throw e
    }
  }

  // Compute worktree path relative to the repo's parent on the remote
  const remotePath = `${repo.path}/../${sanitizedName}`

  // Determine base branch
  // Why: previously fell back to a hardcoded 'origin/main' when
  // symbolic-ref failed. That silently handed addWorktree a ref that may
  // not exist on the remote (e.g. repos whose primary branch is master or
  // develop), producing an opaque git error. Fail here with a clear
  // message so the UI can surface it and prompt the user to pick a base.
  let baseBranch = args.baseBranch || repo.worktreeBaseRef
  if (!baseBranch) {
    try {
      const { stdout } = await provider.exec(
        ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
        repo.path
      )
      baseBranch = stdout.trim()
    } catch {
      // Fall through — baseBranch stays unset.
    }
  }
  if (!baseBranch) {
    throw new Error(
      'Could not resolve a default base ref for this repo. Pick a base branch explicitly and try again.'
    )
  }

  // Fetch latest
  const remote = baseBranch.includes('/') ? baseBranch.split('/')[0] : 'origin'
  try {
    await provider.exec(['fetch', remote], repo.path)
  } catch {
    /* best-effort */
  }

  // Why: the relay's git.addWorktree validates targetDir against registered
  // roots. The worktree sibling path (repo/../name) is outside the repo root
  // and must be registered first. Using request (not notify) makes the
  // ordering guarantee explicit rather than relying on FIFO frame processing,
  // and closes failure windows during relay reconnect or fresh-host scenarios
  // where roots may not yet be registered at all. See issue #911.
  const mux = getActiveMultiplexer(repo.connectionId!)
  if (!mux) {
    throw new Error('SSH connection is not available. Please reconnect and try again.')
  }
  // Why: git.addWorktree validates both repoPath and targetDir against
  // registered roots. In a fresh-host or reconnect scenario, registerRelayRoots
  // may not have finished yet, so neither path may be registered. Register both
  // synchronously here to close that window.
  //
  // Why (fallback): when Orca reconnects via --connect to a relay still in its
  // grace period, the old relay binary may not have the request handler yet.
  // Fall back to notify so worktree creation still works against pre-upgrade
  // relays.
  try {
    await Promise.all([
      mux.request('session.registerRoot', { rootPath: repo.path }),
      mux.request('session.registerRoot', { rootPath: remotePath })
    ])
  } catch (err) {
    if (err instanceof Error && err.message.includes('Method not found')) {
      mux.notify('session.registerRoot', { rootPath: repo.path })
      mux.notify('session.registerRoot', { rootPath: remotePath })
    } else {
      throw err
    }
  }

  // Create worktree via relay
  try {
    await provider.addWorktree(repo.path, branchName, remotePath, {
      base: baseBranch,
      track: baseBranch.includes('/')
    })
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes('No workspace roots registered yet') ||
        err.message.includes('Path outside authorized workspace'))
    ) {
      // Why: validatePath throws two distinct errors — "No workspace roots
      // registered yet" (relay has no roots at all, e.g., reconnect before
      // registerRelayRoots completes) and "Path outside authorized workspace"
      // (roots exist but the sibling worktree path isn't among them). Both are
      // implementation details that mean nothing to the user.
      throw new Error(
        'The SSH relay has not registered the worktree path yet. Please wait a moment and try again, or disconnect and reconnect the SSH session.'
      )
    }
    throw err
  }

  // Re-list to get the created worktree info
  const gitWorktrees = await provider.listWorktrees(repo.path)
  const created = gitWorktrees.find(
    (gw) => gw.branch?.endsWith(branchName) || gw.path.endsWith(sanitizedName)
  )
  if (!created) {
    throw new Error('Worktree created but not found in listing')
  }

  const worktreeId = `${repo.id}::${created.path}`
  const metaUpdates: Partial<WorktreeMeta> = {
    lastActivityAt: Date.now(),
    ...(shouldSetDisplayName(requestedName, branchName, sanitizedName)
      ? { displayName: requestedName }
      : {})
  }
  const meta = store.setWorktreeMeta(worktreeId, metaUpdates)
  const worktree = mergeWorktree(repo.id, created, meta)

  notifyWorktreesChanged(mainWindow, repo.id)
  return { worktree }
}

export async function createLocalWorktree(
  args: CreateWorktreeArgs,
  repo: Repo,
  store: Store,
  mainWindow: BrowserWindow
): Promise<CreateWorktreeResult> {
  const settings = store.getSettings()

  const username = getGitUsername(repo.path)
  const requestedName = args.name
  const sanitizedName = sanitizeWorktreeName(args.name)
  // Why: WSL worktrees live under ~/orca/workspaces inside the WSL
  // filesystem. Validate against that root, not the Windows workspace dir.
  // If WSL home lookup fails, keep using the configured workspace root so
  // the path traversal guard still runs on the fallback path.
  const wslInfo = isWslPath(repo.path) ? parseWslPath(repo.path) : null
  const wslHome = wslInfo ? getWslHome(wslInfo.distro) : null
  const workspaceRoot = wslHome ? join(wslHome, 'orca', 'workspaces') : settings.workspaceDir
  let effectiveRequestedName = requestedName
  let effectiveSanitizedName = sanitizedName
  let branchName = ''
  let worktreePath = ''

  // Why: silently resolve branch/path/PR name collisions by appending -2/-3/etc.
  // instead of failing and forcing the user back to the name picker. This is
  // especially important for the new-workspace flow where the user may not have
  // direct control over the branch name. Bounded by MAX_SUFFIX_ATTEMPTS so a
  // misconfigured environment (e.g. a mock or stub that always reports a
  // conflict) cannot spin this loop indefinitely.
  const MAX_SUFFIX_ATTEMPTS = 100
  let resolved = false
  let lastBranchConflictKind: 'local' | 'remote' | null = null
  let lastExistingPR: Awaited<ReturnType<typeof getPRForBranch>> | null = null
  for (let suffix = 1; suffix <= MAX_SUFFIX_ATTEMPTS; suffix += 1) {
    effectiveSanitizedName = suffix === 1 ? sanitizedName : `${sanitizedName}-${suffix}`
    effectiveRequestedName =
      suffix === 1
        ? requestedName
        : requestedName.trim()
          ? `${requestedName}-${suffix}`
          : effectiveSanitizedName

    branchName = computeBranchName(effectiveSanitizedName, settings, username)
    lastBranchConflictKind = await getBranchConflictKind(repo.path, branchName)
    if (lastBranchConflictKind) {
      continue
    }

    // Why: `gh pr list` is a network round-trip that previously ran on every
    // create, adding ~1–3s to the happy path even when no conflict exists. We
    // only probe PR conflicts once a local/remote branch collision has already
    // forced us past the first suffix — at that point uniqueness matters
    // enough to justify the GitHub call. The common case (brand-new branch
    // name, no collisions) skips the network entirely.
    if (suffix > 1) {
      lastExistingPR = null
      try {
        lastExistingPR = await getPRForBranch(repo.path, branchName)
      } catch {
        // GitHub API may be unreachable, rate-limited, or token missing
      }
      if (lastExistingPR) {
        continue
      }
    }

    worktreePath = ensurePathWithinWorkspace(
      computeWorktreePath(effectiveSanitizedName, repo.path, settings),
      workspaceRoot
    )
    if (existsSync(worktreePath)) {
      continue
    }

    resolved = true
    break
  }

  if (!resolved) {
    // Why: if every suffix in range collides, fall back to the original
    // "reject with a specific reason" behavior so the user sees why creation
    // failed instead of a generic error or (worse) an infinite spinner.
    if (lastExistingPR) {
      throw new Error(
        `Branch "${branchName}" already has PR #${lastExistingPR.number}. Pick a different worktree name.`
      )
    }
    if (lastBranchConflictKind) {
      throw new Error(
        `Branch "${branchName}" already exists ${lastBranchConflictKind === 'local' ? 'locally' : 'on a remote'}. Pick a different worktree name.`
      )
    }
    throw new Error(
      `Could not find an available worktree name for "${sanitizedName}". Pick a different worktree name.`
    )
  }

  // Determine base branch.
  //
  // Why: getDefaultBaseRef may return null when none of origin/HEAD,
  // origin/main, origin/master, local main, or local master exist. In that
  // case we must not fall back to a hardcoded 'origin/main' — passing a
  // non-existent ref to `git worktree add` produces an opaque error. Fail
  // here with a clear message so the UI can prompt the user to pick a base
  // branch explicitly.
  const baseBranch = args.baseBranch || repo.worktreeBaseRef || getDefaultBaseRef(repo.path)
  if (!baseBranch) {
    throw new Error(
      'Could not resolve a default base ref for this repo. Pick a base branch explicitly and try again.'
    )
  }
  const setupScript = getEffectiveHooks(repo)?.scripts.setup
  // Why: `ask` is a pre-create choice gate, not a post-create side effect.
  // Resolve it before mutating git state so missing UI input cannot strand
  // a real worktree on disk while the renderer reports "create failed".
  const shouldLaunchSetup = setupScript ? shouldRunSetupForCreate(repo, args.setupDecision) : false

  // Why: `git fetch` previously blocked worktree creation for 1–5s on every
  // click, even though the fetch result isn't actually required — the
  // subsequent `git worktree add` uses whatever local ref `baseBranch` points
  // at. Kicking fetch off in parallel lets the worktree be created off the
  // last-known tip while the fetch completes in the background; the next
  // user action (pull, diff, PR create) will see the refreshed remote state.
  const remote = baseBranch.includes('/') ? baseBranch.split('/')[0] : 'origin'
  void gitExecFileAsync(['fetch', remote], { cwd: repo.path }).catch(() => {
    // Fetch is best-effort — don't block worktree creation if offline
  })

  await addWorktree(
    repo.path,
    worktreePath,
    branchName,
    baseBranch,
    settings.refreshLocalBaseRefOnWorktreeCreate
  )

  // Re-list to get the freshly created worktree info
  const gitWorktrees = await listWorktrees(repo.path)
  const created = gitWorktrees.find((gw) => areWorktreePathsEqual(gw.path, worktreePath))
  if (!created) {
    throw new Error('Worktree created but not found in listing')
  }

  const worktreeId = `${repo.id}::${created.path}`
  const metaUpdates: Partial<WorktreeMeta> = {
    // Stamp activity so the worktree sorts into its final position
    // immediately — prevents scroll-to-reveal racing with a later
    // bumpWorktreeActivity that would re-sort the list.
    lastActivityAt: Date.now(),
    ...(shouldSetDisplayName(effectiveRequestedName, branchName, effectiveSanitizedName)
      ? { displayName: effectiveRequestedName }
      : {})
  }
  const meta = store.setWorktreeMeta(worktreeId, metaUpdates)
  const worktree = mergeWorktree(repo.id, created, meta)
  // Why: the authorized-roots cache is consulted lazily on the next filesystem
  // access (`ensureAuthorizedRootsCache` rebuilds on demand when dirty). We
  // just invalidate the cache marker instead of blocking worktree creation on
  // an immediate rebuild, which can spawn `git worktree list` per repo and
  // adds 100ms+ to every create.
  invalidateAuthorizedRootsCache()

  let setup: CreateWorktreeResult['setup']
  if (setupScript && shouldLaunchSetup) {
    try {
      // Why: setup now runs in a visible terminal owned by the renderer so users
      // can inspect failures, answer prompts, and rerun it. The main process only
      // resolves policy and writes the runner script; it must not execute setup
      // itself anymore or we would reintroduce the hidden background-hook behavior.
      //
      // Why: the git worktree already exists at this point. If runner generation
      // fails, surfacing the error as a hard create failure would lie to the UI
      // about the underlying git state and strand a real worktree on disk.
      // Degrade to "created without setup launch" instead.
      setup = createSetupRunnerScript(repo, worktreePath, setupScript)
    } catch (error) {
      console.error(`[hooks] Failed to prepare setup runner for ${worktreePath}:`, error)
    }
  }

  notifyWorktreesChanged(mainWindow, repo.id)
  return {
    worktree,
    ...(setup ? { setup } : {})
  }
}
