/* eslint-disable max-lines */
// Why: extracted from worktrees.ts to keep the main IPC module under the
// max-lines threshold. Worktree creation helpers (local and remote) live
// here so the IPC dispatch file stays focused on handler wiring. The
// sparse-checkout flow plus the post-create setup-runner wiring pushed
// this file marginally over the per-file limit; matches the
// eslint-disable pattern other files in src/renderer use when a
// cohesive flow would split awkwardly.

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
import { listWorktrees, addWorktree, addSparseWorktree } from '../git/worktree'
import { getGitUsername, getDefaultBaseRef, getBranchConflictKind } from '../git/repo'
import { gitExecFileAsync } from '../git/runner'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
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
import { createWorktreeSymlinks } from './worktree-symlinks'
import { normalizeSparseDirectories } from './sparse-checkout-directories'

export function notifyWorktreesChanged(mainWindow: BrowserWindow, repoId: string): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('worktrees:changed', { repoId })
  }
}

// Why (§3.3): two-phase spinner. Main process fires `'fetching'` immediately
// after kicking off `git fetch` and `'creating'` after that fetch resolves
// (or is determined to be cache-fresh). Renderer swaps its spinner label in
// response; fallback is the static "Creating worktree..." label if no event
// arrives (e.g. renderer races destruction of the window).
export function emitCreateWorktreeProgress(
  mainWindow: BrowserWindow,
  phase: 'fetching' | 'creating'
): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('createWorktree:progress', { phase })
  }
}

export async function createRemoteWorktree(
  args: CreateWorktreeArgs,
  repo: Repo,
  store: Store,
  mainWindow: BrowserWindow
): Promise<CreateWorktreeResult> {
  if (args.sparseCheckout) {
    throw new Error('Sparse checkout is not supported for remote SSH repos yet.')
  }

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
  const now = Date.now()
  const metaUpdates: Partial<WorktreeMeta> = {
    lastActivityAt: now,
    // Why: grants the new worktree a short grace window at the top of the
    // Recent sort. During worktree creation (git fetch + add can take several
    // seconds) other worktrees get ambient PTY bumps that would otherwise
    // leave the newly-created one below them; the Recent comparator uses
    // max(lastActivityAt, createdAt + GRACE_MS) to keep it on top until the
    // window elapses. See smart-sort.ts `CREATE_GRACE_MS`.
    createdAt: now,
    ...(shouldSetDisplayName(requestedName, branchName, sanitizedName)
      ? { displayName: requestedName }
      : {})
  }
  const meta = store.setWorktreeMeta(worktreeId, metaUpdates)
  const worktree = mergeWorktree(repo.id, created, meta)

  // Why: `experimentalWorktreeSymlinks` is intentionally not wired up for
  // remote (SSH) worktrees. Creating symlinks on the remote host would
  // require a new relay method and authorization surface; the feature is
  // local-only until that protocol work is in scope. Remote repos with
  // `symlinkPaths` configured have them silently ignored here.

  notifyWorktreesChanged(mainWindow, repo.id)
  return { worktree }
}

export async function createLocalWorktree(
  args: CreateWorktreeArgs,
  repo: Repo,
  store: Store,
  mainWindow: BrowserWindow,
  runtime?: OrcaRuntimeService
): Promise<CreateWorktreeResult> {
  const settings = store.getSettings()

  const username = getGitUsername(repo.path)
  const requestedName = args.name
  const sanitizedName = sanitizeWorktreeName(args.name)

  // Why (§3.3): determine the base branch (and therefore the remote we need to
  // fetch) FIRST, so the fetch can overlap all pre-create work below. Neither
  // of these calls depends on the suffix loop / PR probe / branch-conflict
  // resolution, so they are safe to hoist.
  const baseBranch = args.baseBranch || repo.worktreeBaseRef || getDefaultBaseRef(repo.path)
  if (!baseBranch) {
    // Why: getDefaultBaseRef may return null when none of origin/HEAD,
    // origin/main, origin/master, local main, or local master exist. Don't
    // fall back to a hardcoded 'origin/main' — passing a non-existent ref to
    // `git worktree add` produces an opaque error. Fail here with a clear
    // message so the UI can prompt the user to pick a base branch explicitly.
    throw new Error(
      'Could not resolve a default base ref for this repo. Pick a base branch explicitly and try again.'
    )
  }

  // Why (§3.3 Lifecycle): fire fetch via the shared 30s-window cache on the
  // runtime so repeat creates on the same repo reuse the in-flight promise
  // and dispatch probes benefit from the freshness window. Kicked off BEFORE
  // the suffix loop / PR probe / path resolution so those operations overlap
  // the network round-trip — the `await` right before `addWorktree` is the
  // only point that actually requires fetch completion.
  //
  // Why `runtime` is optional: a handful of legacy IPC test harnesses still
  // call createLocalWorktree without the runtime. In that case we fall back
  // to the old fire-and-forget behavior (which those tests already expect).
  // Production `worktrees.ts` always passes runtime, so the happy path
  // always gets the cache.
  const remote = baseBranch.includes('/') ? baseBranch.split('/')[0] : 'origin'
  const fetchPromise: Promise<void> = runtime
    ? runtime.fetchRemoteWithCache(repo.path, remote)
    : gitExecFileAsync(['fetch', remote], { cwd: repo.path })
        .then(() => undefined)
        .catch(() => undefined)

  // Why: emit a progress event so the renderer dialog can switch its spinner
  // label to "Checking for updates..." while the fetch is in flight, then
  // "Creating worktree..." after we await it. Renderer falls back to the
  // static "Creating worktree..." label if no event arrives.
  emitCreateWorktreeProgress(mainWindow, 'fetching')
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

  // Why: `ask` is a pre-create choice gate, not a post-create side effect.
  // Resolve it before mutating git state so missing UI input cannot strand
  // a real worktree on disk while the renderer reports "create failed". The
  // actual run/skip decision is recomputed after the worktree exists against
  // the worktree-bound setup script.
  const primarySetupScript = getEffectiveHooks(repo)?.scripts.setup
  if (primarySetupScript) {
    shouldRunSetupForCreate(repo, args.setupDecision)
  }
  const sparseDirectories = args.sparseCheckout
    ? normalizeSparseDirectories(args.sparseCheckout.directories)
    : []
  if (args.sparseCheckout && sparseDirectories.length === 0) {
    throw new Error('Sparse checkout requires at least one repo-relative directory.')
  }
  let sparsePresetId: string | undefined
  if (args.sparseCheckout?.presetId) {
    const preset = store
      .getSparsePresets(repo.id)
      .find((entry) => entry.id === args.sparseCheckout?.presetId)
    if (preset?.repoId === repo.id) {
      try {
        const presetDirectories = normalizeSparseDirectories(preset.directories)
        // Why: use Set-based comparison so directory order does not affect
        // attribution — matches the renderer's sparseDirectoriesMatch logic.
        const presetSet = new Set(presetDirectories)
        const directoriesMatch =
          presetDirectories.length === sparseDirectories.length &&
          sparseDirectories.every((entry) => presetSet.has(entry))
        sparsePresetId = directoriesMatch ? preset.id : undefined
      } catch {
        // Why: corrupt preset data should not block creation or falsely label the new worktree.
      }
    }
  }

  // Why (§3.3): gate on the fetch we fired at the top of this function.
  // Pre-create probes (branch-conflict, PR probe, path resolution, sparse
  // prep) already ran concurrently with the fetch; in the warm case this
  // await is a no-op. In the cold case the spinner has already shown
  // "Checking for updates..." so the user sees the wait is legible.
  //
  // `fetchRemoteWithCache` never rejects (log-and-proceed on offline
  // failure), so the bare `await` does not need a try/catch here.
  await fetchPromise
  emitCreateWorktreeProgress(mainWindow, 'creating')

  await (sparseDirectories.length > 0
    ? addSparseWorktree(
        repo.path,
        worktreePath,
        branchName,
        sparseDirectories,
        baseBranch,
        settings.refreshLocalBaseRefOnWorktreeCreate
      )
    : addWorktree(
        repo.path,
        worktreePath,
        branchName,
        baseBranch,
        settings.refreshLocalBaseRefOnWorktreeCreate
      ))

  // Re-list to get the freshly created worktree info
  const gitWorktrees = await listWorktrees(repo.path)
  const created = gitWorktrees.find((gw) => areWorktreePathsEqual(gw.path, worktreePath))
  if (!created) {
    throw new Error('Worktree created but not found in listing')
  }

  const worktreeId = `${repo.id}::${created.path}`
  const now = Date.now()
  const metaUpdates: Partial<WorktreeMeta> = {
    // Stamp activity so the worktree sorts into its final position
    // immediately — prevents scroll-to-reveal racing with a later
    // bumpWorktreeActivity that would re-sort the list.
    lastActivityAt: now,
    // See createRemoteWorktree above: createdAt protects the newly-created
    // worktree from ambient PTY bumps in other worktrees for CREATE_GRACE_MS.
    createdAt: now,
    ...(shouldSetDisplayName(effectiveRequestedName, branchName, effectiveSanitizedName)
      ? { displayName: effectiveRequestedName }
      : {}),
    ...(sparseDirectories.length > 0
      ? {
          sparseDirectories,
          sparseBaseRef: baseBranch,
          sparsePresetId
        }
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

  // Why: create user-configured symlinks from the primary checkout into the
  // new worktree before any setup script runs, so scripts that reuse shared
  // state (e.g. `node_modules`, `.env`) see the links already in place.
  // Gated on the experimental flag so disabling the feature globally skips
  // the work even when a repo still has paths configured.
  if (settings.experimentalWorktreeSymlinks && repo.symlinkPaths && repo.symlinkPaths.length > 0) {
    await createWorktreeSymlinks(repo.path, created.path, repo.symlinkPaths)
  }

  // Why: the worktree's own `orca.yaml` (at the tip of the base branch) is
  // authoritative for what runs post-creation. The repo-level trust already
  // granted by the user in the pre-create flow covers execution of that
  // script; we intentionally do not re-gate on content equality with the
  // primary checkout's preview, because benign divergence (whitespace,
  // comments, or any setup-script edit that has landed on the base branch
  // but not yet been pulled into the primary checkout) was silently
  // disabling setup with no UI signal. See #1280 for the original gate and
  // the regression this replaced.
  let setup: CreateWorktreeResult['setup']
  const setupScript = getEffectiveHooks(repo, worktreePath)?.scripts.setup
  let shouldLaunchSetup = false
  if (setupScript) {
    try {
      shouldLaunchSetup = shouldRunSetupForCreate(repo, args.setupDecision)
    } catch (error) {
      // Why: if the target branch introduces setup hooks that the primary
      // checkout did not expose, the renderer may not have collected an ask
      // decision. The worktree already exists, so skip setup instead of
      // turning successful git creation into an IPC failure.
      console.warn(`[hooks] setup hook skipped for ${worktreePath}:`, error)
    }
  }
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
