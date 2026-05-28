/* eslint-disable max-lines */
// Why: extracted from worktrees.ts to keep the main IPC module under the
// max-lines threshold. Worktree creation helpers (local and remote) live
// here so the IPC dispatch file stays focused on handler wiring. The
// sparse-checkout flow plus the post-create setup-runner wiring pushed
// this file marginally over the per-file limit; matches the
// eslint-disable pattern other files in src/renderer use when a
// cohesive flow would split awkwardly.

import type { BrowserWindow } from 'electron'
import { join, posix, win32 } from 'path'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import type { Store } from '../persistence'
import type {
  CreateWorktreeArgs,
  CreateWorktreeResult,
  GitPushTarget,
  LocalBaseRefRefreshResult,
  Repo,
  WorktreeMeta
} from '../../shared/types'
import { getPRForBranch } from '../github/client'
import { listWorktrees, addWorktree, addSparseWorktree, parseWorktreeList } from '../git/worktree'
import type { AddWorktreeResult } from '../git/worktree'
import { getGitUsername, getDefaultBaseRef, getBranchConflictKind } from '../git/repo'
import { validateGitPushTarget } from '../git/push-target-validation'
import { assertGitPushTargetShape } from '../../shared/git-push-target-validation'
import { gitExecFileAsync } from '../git/runner'
import { parseGitHubOwnerRepo } from '../github/gh-utils'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RemoteFetchResult, RemoteTrackingBase } from '../runtime/orca-runtime'
import { isWslPath, parseWslPath, getWslHome } from '../wsl'
import {
  buildPosixRunnerScript,
  buildWindowsRunnerScript,
  createSetupRunnerScript,
  getEffectiveHooks,
  getEffectiveHooksFromConfig,
  getSetupRunnerEnvVars,
  parseOrcaYaml,
  shouldRunSetupForCreate
} from '../hooks'
import { requireSshGitProvider } from '../providers/ssh-git-dispatch'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { getActiveMultiplexer } from './ssh'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { getSshGitUsername } from '../git/git-username'
import {
  sanitizeWorktreeName,
  sanitizeWorktreeDisplayName,
  computeBranchName,
  computeWorktreePath,
  ensurePathWithinWorkspace,
  shouldSetDisplayName,
  mergeWorktree,
  areWorktreePathsEqual
} from './worktree-logic'
import { getRepoIdFromWorktreeId } from '../../shared/worktree-id'
import { invalidateAuthorizedRootsCache } from './filesystem-auth'
import { createWorktreeSymlinks } from './worktree-symlinks'
import { normalizeSparseDirectories } from './sparse-checkout-directories'
import { joinWorktreeRelativePath } from '../runtime/runtime-relative-paths'
import type { IFilesystemProvider } from '../providers/types'

async function unsetRemoteWorktreeCreationBase(
  provider: SshGitProvider,
  worktreePath: string,
  branchName: string
): Promise<void> {
  try {
    await provider.exec(
      ['config', '--local', '--unset-all', `branch.${branchName}.base`],
      worktreePath
    )
  } catch {
    // Best-effort SSH sparse cleanup; keep the sparse setup error as the
    // actionable failure and let removeWorktree handle the partial checkout.
  }
}

async function findRemoteForUrl(repoPath: string, remoteUrl: string): Promise<string | null> {
  const target = parseGitHubOwnerRepo(remoteUrl)
  try {
    const { stdout } = await gitExecFileAsync(['remote'], { cwd: repoPath })
    for (const remote of stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)) {
      try {
        const { stdout: urlStdout } = await gitExecFileAsync(['remote', 'get-url', remote], {
          cwd: repoPath
        })
        const candidateUrl = urlStdout.trim()
        const candidate = parseGitHubOwnerRepo(candidateUrl)
        if (
          target &&
          candidate &&
          target.owner.toLowerCase() === candidate.owner.toLowerCase() &&
          target.repo.toLowerCase() === candidate.repo.toLowerCase()
        ) {
          return remote
        }
        if (candidateUrl === remoteUrl) {
          return remote
        }
      } catch {
        // Ignore a remote that disappeared or has no fetch URL.
      }
    }
  } catch {
    return null
  }
  return null
}

async function resolveCreateBranchName(
  repoPath: string,
  branchNameOverride: string | undefined,
  sanitizedName: string,
  settings: { branchPrefix: string; branchPrefixCustom?: string },
  username: string | null
): Promise<string> {
  if (!branchNameOverride) {
    return computeBranchName(sanitizedName, settings, username)
  }
  if (branchNameOverride.startsWith('-')) {
    throw new Error('Branch name must not start with "-"')
  }
  await gitExecFileAsync(['check-ref-format', '--branch', branchNameOverride], { cwd: repoPath })
  return branchNameOverride
}

async function resolveCreateBranchNameSsh(
  provider: SshGitProvider,
  repoPath: string,
  branchNameOverride: string | undefined,
  sanitizedName: string,
  settings: { branchPrefix: string; branchPrefixCustom?: string },
  username: string | null
): Promise<string> {
  if (!branchNameOverride) {
    return computeBranchName(sanitizedName, settings, username)
  }
  if (branchNameOverride.startsWith('-')) {
    throw new Error('Branch name must not start with "-"')
  }
  await provider.exec(['check-ref-format', '--branch', branchNameOverride], repoPath)
  return branchNameOverride
}

function normalizeLocalBranchName(branchName: string | undefined): string {
  return branchName?.replace(/^refs\/heads\//, '') ?? ''
}

async function canCheckoutExistingLocalBranch(
  repoPath: string,
  branchName: string,
  baseBranch: string
): Promise<boolean> {
  if (normalizeLocalBranchName(baseBranch) !== branchName) {
    return false
  }
  try {
    await gitExecFileAsync(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}^{commit}`],
      {
        cwd: repoPath
      }
    )
  } catch {
    return false
  }
  const worktrees = await listWorktrees(repoPath)
  return !worktrees.some((worktree) => normalizeLocalBranchName(worktree.branch) === branchName)
}

async function canCheckoutExistingLocalBranchSsh(
  provider: SshGitProvider,
  repoPath: string,
  branchName: string,
  baseBranch: string
): Promise<boolean> {
  if (normalizeLocalBranchName(baseBranch) !== branchName) {
    return false
  }
  try {
    await provider.exec(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}^{commit}`],
      repoPath
    )
  } catch {
    return false
  }
  const worktrees = await provider.listWorktrees(repoPath)
  return !worktrees.some((worktree) => normalizeLocalBranchName(worktree.branch) === branchName)
}

async function ensureUniqueRemoteName(repoPath: string, preferred: string): Promise<string> {
  const { stdout } = await gitExecFileAsync(['remote'], { cwd: repoPath })
  const existing = new Set(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  )
  if (!existing.has(preferred)) {
    return preferred
  }
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${preferred}-${suffix}`
    if (!existing.has(candidate)) {
      return candidate
    }
  }
  throw new Error(`Could not find an available remote name for ${preferred}.`)
}

export async function prepareWorktreePushTarget(
  repoPath: string,
  target: GitPushTarget,
  store?: WorktreePushTargetStore,
  repoId?: string
): Promise<GitPushTarget> {
  await validateGitPushTarget(repoPath, target)
  const { remoteCreated: _ignoredRemoteCreated, ...sanitizedTarget } = target
  let remoteName = target.remoteName
  let remoteCreated = false
  if (target.remoteUrl) {
    const existingRemote = await findRemoteForUrl(repoPath, target.remoteUrl)
    if (existingRemote) {
      remoteName = existingRemote
      // Why: if a later PR worktree reuses an Orca-created fork remote, it
      // must inherit ownership so deleting the final user can remove it.
      remoteCreated = store
        ? isPushTargetRemoteCreatedByKnownWorktree(
            store,
            {
              ...target,
              remoteName: existingRemote
            },
            repoId
          )
        : false
    } else {
      remoteName = await ensureUniqueRemoteName(repoPath, target.remoteName)
      await gitExecFileAsync(['remote', 'add', remoteName, target.remoteUrl], { cwd: repoPath })
      remoteCreated = true
    }
  }

  await gitExecFileAsync(
    [
      'fetch',
      remoteName,
      `+refs/heads/${target.branchName}:refs/remotes/${remoteName}/${target.branchName}`
    ],
    { cwd: repoPath }
  )
  return {
    ...sanitizedTarget,
    remoteName,
    ...(remoteCreated ? { remoteCreated: true } : {})
  }
}

type GitRemoteExec = (args: string[], cwd: string) => Promise<{ stdout: string; stderr?: string }>
type WorktreePushTargetStore = Pick<Store, 'getAllWorktreeMeta'>

function sameGitHubRemoteUrl(left: string, right: string): boolean {
  if (left === right) {
    return true
  }
  const parsedLeft = parseGitHubOwnerRepo(left)
  const parsedRight = parseGitHubOwnerRepo(right)
  return Boolean(
    parsedLeft &&
    parsedRight &&
    parsedLeft.owner.toLowerCase() === parsedRight.owner.toLowerCase() &&
    parsedLeft.repo.toLowerCase() === parsedRight.repo.toLowerCase()
  )
}

function isPushTargetUsedByAnotherWorktree(
  store: WorktreePushTargetStore,
  removedWorktreeId: string,
  target: GitPushTarget
): boolean {
  const removedRepoId = getRepoIdFromWorktreeId(removedWorktreeId)
  return Object.entries(store.getAllWorktreeMeta()).some(([worktreeId, meta]) => {
    // Why: git remotes are repo-local; matching metadata from another repo
    // must not pin this repo's fork remote forever.
    const belongsToSameRepo = getRepoIdFromWorktreeId(worktreeId) === removedRepoId
    if (worktreeId === removedWorktreeId || !belongsToSameRepo || !meta.pushTarget) {
      return false
    }
    const otherRemoteUrl = meta.pushTarget.remoteUrl
    const targetRemoteUrl = target.remoteUrl
    return (
      meta.pushTarget.remoteName === target.remoteName ||
      (typeof otherRemoteUrl === 'string' &&
        typeof targetRemoteUrl === 'string' &&
        sameGitHubRemoteUrl(otherRemoteUrl, targetRemoteUrl))
    )
  })
}

function isPushTargetRemoteCreatedByKnownWorktree(
  store: WorktreePushTargetStore,
  target: GitPushTarget,
  repoId?: string
): boolean {
  return Object.entries(store.getAllWorktreeMeta()).some(([worktreeId, meta]) => {
    if (repoId && getRepoIdFromWorktreeId(worktreeId) !== repoId) {
      return false
    }
    if (!meta.pushTarget?.remoteCreated) {
      return false
    }
    const otherRemoteUrl = meta.pushTarget.remoteUrl
    const targetRemoteUrl = target.remoteUrl
    return (
      meta.pushTarget.remoteName === target.remoteName ||
      (typeof otherRemoteUrl === 'string' &&
        typeof targetRemoteUrl === 'string' &&
        sameGitHubRemoteUrl(otherRemoteUrl, targetRemoteUrl))
    )
  })
}

async function hasBranchConfigUsingRemote(
  execGit: GitRemoteExec,
  repoPath: string,
  target: GitPushTarget
): Promise<boolean> {
  try {
    const { stdout } = await execGit(
      ['config', '--get-regexp', '^branch\\..*\\.(remote|pushRemote)$'],
      repoPath
    )
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .some((line) => {
        const value = line.split(/\s+/).slice(1).join(' ')
        return value === target.remoteName || value === target.remoteUrl
      })
  } catch {
    return false
  }
}

async function cleanupUnusedWorktreePushTargetRemoteWithExec(
  repoPath: string,
  removedWorktreeId: string,
  target: GitPushTarget | undefined,
  store: WorktreePushTargetStore,
  execGit: GitRemoteExec
): Promise<void> {
  if (
    !target?.remoteCreated ||
    !target.remoteUrl ||
    target.remoteName === 'origin' ||
    target.remoteName === 'upstream'
  ) {
    return
  }
  if (isPushTargetUsedByAnotherWorktree(store, removedWorktreeId, target)) {
    return
  }
  if (await hasBranchConfigUsingRemote(execGit, repoPath, target)) {
    return
  }

  let configuredRemoteUrl: string
  try {
    configuredRemoteUrl = (
      await execGit(['remote', 'get-url', target.remoteName], repoPath)
    ).stdout.trim()
  } catch {
    return
  }
  if (!sameGitHubRemoteUrl(configuredRemoteUrl, target.remoteUrl)) {
    return
  }

  await execGit(['remote', 'remove', target.remoteName], repoPath)
}

export async function cleanupUnusedWorktreePushTargetRemote(
  repoPath: string,
  removedWorktreeId: string,
  target: GitPushTarget | undefined,
  store: WorktreePushTargetStore
): Promise<void> {
  try {
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      repoPath,
      removedWorktreeId,
      target,
      store,
      (args, cwd) => gitExecFileAsync(args, { cwd })
    )
  } catch (error) {
    console.warn(`[worktrees] Failed to clean up fork PR remote for ${removedWorktreeId}`, error)
  }
}

export async function configureCreatedWorktreePushTarget(
  worktreePath: string,
  branchName: string,
  target: GitPushTarget
): Promise<GitPushTarget> {
  await gitExecFileAsync(
    ['branch', '--set-upstream-to', `${target.remoteName}/${target.branchName}`, branchName],
    { cwd: worktreePath }
  )
  return target
}

async function findRemoteForUrlSsh(
  provider: SshGitProvider,
  repoPath: string,
  remoteUrl: string
): Promise<string | null> {
  const target = parseGitHubOwnerRepo(remoteUrl)
  try {
    const { stdout } = await provider.exec(['remote'], repoPath)
    for (const remote of stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)) {
      try {
        const { stdout: urlStdout } = await provider.exec(['remote', 'get-url', remote], repoPath)
        const candidateUrl = urlStdout.trim()
        const candidate = parseGitHubOwnerRepo(candidateUrl)
        if (
          target &&
          candidate &&
          target.owner.toLowerCase() === candidate.owner.toLowerCase() &&
          target.repo.toLowerCase() === candidate.repo.toLowerCase()
        ) {
          return remote
        }
        if (candidateUrl === remoteUrl) {
          return remote
        }
      } catch {
        // Ignore a remote that disappeared or has no fetch URL.
      }
    }
  } catch {
    return null
  }
  return null
}

async function ensureUniqueRemoteNameSsh(
  provider: SshGitProvider,
  repoPath: string,
  preferred: string
): Promise<string> {
  const { stdout } = await provider.exec(['remote'], repoPath)
  const existing = new Set(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  )
  if (!existing.has(preferred)) {
    return preferred
  }
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${preferred}-${suffix}`
    if (!existing.has(candidate)) {
      return candidate
    }
  }
  throw new Error(`Could not find an available remote name for ${preferred}.`)
}

async function prepareWorktreePushTargetSsh(
  provider: SshGitProvider,
  repoPath: string,
  target: GitPushTarget,
  store?: WorktreePushTargetStore,
  repoId?: string
): Promise<GitPushTarget> {
  assertGitPushTargetShape(target)
  const { remoteCreated: _ignoredRemoteCreated, ...sanitizedTarget } = target
  await provider.exec(['check-ref-format', '--branch', target.branchName], repoPath)
  let remoteName = target.remoteName
  let remoteCreated = false
  if (target.remoteUrl) {
    const existingRemote = await findRemoteForUrlSsh(provider, repoPath, target.remoteUrl)
    if (existingRemote) {
      remoteName = existingRemote
      // Why: if a later PR worktree reuses an Orca-created fork remote, it
      // must inherit ownership so deleting the final user can remove it.
      remoteCreated = store
        ? isPushTargetRemoteCreatedByKnownWorktree(
            store,
            {
              ...target,
              remoteName: existingRemote
            },
            repoId
          )
        : false
    } else {
      remoteName = await ensureUniqueRemoteNameSsh(provider, repoPath, target.remoteName)
      await provider.exec(['remote', 'add', remoteName, target.remoteUrl], repoPath)
      remoteCreated = true
    }
  }
  await provider.fetchRemoteTrackingRef(
    repoPath,
    remoteName,
    target.branchName,
    `refs/remotes/${remoteName}/${target.branchName}`
  )
  return { ...sanitizedTarget, remoteName, ...(remoteCreated ? { remoteCreated: true } : {}) }
}

export async function cleanupUnusedWorktreePushTargetRemoteSsh(
  provider: SshGitProvider,
  repoPath: string,
  removedWorktreeId: string,
  target: GitPushTarget | undefined,
  store: WorktreePushTargetStore
): Promise<void> {
  try {
    await cleanupUnusedWorktreePushTargetRemoteWithExec(
      repoPath,
      removedWorktreeId,
      target,
      store,
      (args, cwd) => provider.exec(args, cwd)
    )
  } catch (error) {
    console.warn(
      `[worktrees] Failed to clean up remote fork PR remote for ${removedWorktreeId}`,
      error
    )
  }
}

async function configureCreatedWorktreePushTargetSsh(
  provider: SshGitProvider,
  worktreePath: string,
  branchName: string,
  target: GitPushTarget
): Promise<GitPushTarget> {
  await provider.exec(
    ['branch', '--set-upstream-to', `${target.remoteName}/${target.branchName}`, branchName],
    worktreePath
  )
  return target
}

async function readRemoteEffectiveHooks(
  repo: Repo,
  fsProvider: IFilesystemProvider,
  hooksRootPath: string
): Promise<ReturnType<typeof getEffectiveHooksFromConfig>> {
  try {
    const result = await fsProvider.readFile(joinWorktreeRelativePath(hooksRootPath, 'orca.yaml'))
    const yamlHooks = result.isBinary ? null : parseOrcaYaml(result.content)
    return getEffectiveHooksFromConfig(repo, yamlHooks)
  } catch {
    return getEffectiveHooksFromConfig(repo, null)
  }
}

async function createRemoteSetupRunnerScript(
  repo: Repo,
  worktreePath: string,
  script: string,
  gitProvider: SshGitProvider,
  fsProvider: IFilesystemProvider
): Promise<CreateWorktreeResult['setup']> {
  const useWindowsFormat = isWindowsAbsolutePathLike(worktreePath)
  const runnerRelativePath = useWindowsFormat ? 'orca/setup-runner.cmd' : 'orca/setup-runner.sh'
  const { stdout } = await gitProvider.exec(
    ['rev-parse', '--git-path', runnerRelativePath],
    worktreePath
  )
  const runnerScriptPath = stdout.trim()
  const runnerDir = useWindowsFormat
    ? win32.dirname(runnerScriptPath)
    : posix.dirname(runnerScriptPath)
  await fsProvider.createDir(runnerDir)
  await fsProvider.writeFile(
    runnerScriptPath,
    useWindowsFormat ? buildWindowsRunnerScript(script) : buildPosixRunnerScript(script)
  )
  return {
    runnerScriptPath,
    envVars: getSetupRunnerEnvVars(repo, worktreePath)
  }
}

async function resolveRemoteTrackingBaseSsh(
  provider: SshGitProvider,
  repoPath: string,
  baseBranch: string
): Promise<RemoteTrackingBase | null> {
  let remotes: string[]
  try {
    const { stdout } = await provider.exec(['remote'], repoPath)
    remotes = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return null
  }

  const remote = remotes
    .filter((candidate) => baseBranch.startsWith(`${candidate}/`))
    .sort((a, b) => b.length - a.length)[0]
  if (!remote) {
    return null
  }
  const branch = baseBranch.slice(remote.length + 1)
  if (!branch) {
    return null
  }
  return {
    remote,
    branch,
    ref: `refs/remotes/${remote}/${branch}`,
    base: baseBranch
  }
}

async function refreshLocalBaseRefForRemoteWorktreeCreate(
  provider: SshGitProvider,
  repoPath: string,
  remoteTrackingBase: RemoteTrackingBase
): Promise<LocalBaseRefRefreshResult> {
  const resultBase = {
    baseRef: remoteTrackingBase.base,
    localBranch: remoteTrackingBase.branch
  }
  const fullRef = `refs/heads/${remoteTrackingBase.branch}`

  try {
    await provider.exec(
      ['merge-base', '--is-ancestor', remoteTrackingBase.branch, remoteTrackingBase.ref],
      repoPath
    )
  } catch {
    return { ...resultBase, status: 'skipped_not_fast_forward' }
  }

  try {
    const { stdout: worktreeListOutput } = await provider.exec(
      ['worktree', 'list', '--porcelain'],
      repoPath
    )
    const worktrees = parseWorktreeList(worktreeListOutput)
    const ownerWorktree = worktrees.find((wt) => wt.branch === fullRef)

    if (ownerWorktree) {
      const { stdout: status } = await provider.exec(
        ['status', '--porcelain', '--untracked-files=no'],
        ownerWorktree.path
      )
      if (status.trim()) {
        return {
          ...resultBase,
          status: 'skipped_dirty_worktree',
          ownerWorktreePath: ownerWorktree.path
        }
      }
      await provider.exec(['reset', '--hard', remoteTrackingBase.ref], ownerWorktree.path)
      return { ...resultBase, status: 'updated', ownerWorktreePath: ownerWorktree.path }
    }

    await provider.exec(['update-ref', fullRef, remoteTrackingBase.ref], repoPath)
    return { ...resultBase, status: 'updated' }
  } catch {
    return { ...resultBase, status: 'skipped_error' }
  }
}

export function notifyWorktreesChanged(mainWindow: BrowserWindow, repoId: string): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('worktrees:changed', { repoId })
  }
}

// Why: two-phase spinner. Main process fires `'fetching'` before waiting on
// pre-create fetch work and `'creating'` immediately before `git worktree add`.
// Renderer swaps its spinner label in response; fallback is the static
// "Creating worktree..." label if no event arrives.
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
  const provider = requireSshGitProvider(repo.connectionId!)

  const settings = store.getSettings()
  const requestedName = args.name
  const sanitizedName = sanitizeWorktreeName(args.name)
  const requestedDisplayName = args.displayName
    ? sanitizeWorktreeDisplayName(args.displayName)
    : undefined

  // Why: SSH targets cannot use the local `gh` account, and git email/name are
  // commit author identity rather than hosted-account usernames.
  const username = await getSshGitUsername(provider, repo.path)

  const branchName = await resolveCreateBranchNameSsh(
    provider,
    repo.path,
    args.branchNameOverride,
    sanitizedName,
    settings,
    username
  )

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

  const checkoutExistingBranch = await canCheckoutExistingLocalBranchSsh(
    provider,
    repo.path,
    branchName,
    baseBranch
  )
  if (!checkoutExistingBranch) {
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

  const remoteTrackingBase = await resolveRemoteTrackingBaseSsh(provider, repo.path, baseBranch)
  if (remoteTrackingBase) {
    try {
      await provider.fetchRemoteTrackingRef(
        repo.path,
        remoteTrackingBase.remote,
        remoteTrackingBase.branch,
        remoteTrackingBase.ref
      )
    } catch {
      throw new Error(
        `Could not refresh base ref "${baseBranch}" from "${remoteTrackingBase.remote}". Check your network and try again.`
      )
    }
  } else {
    // Why: local or otherwise non-remote-tracking bases preserve legacy
    // best-effort fetch behavior. Only remote-tracking bases must fail closed,
    // because creating from them after a failed refresh silently makes stale worktrees.
    const fallbackRemote = baseBranch.includes('/') ? baseBranch.split('/')[0] : 'origin'
    try {
      await provider.exec(['fetch', fallbackRemote], repo.path)
    } catch {
      /* best-effort */
    }
  }
  const localBaseRefRefresh =
    settings.refreshLocalBaseRefOnWorktreeCreate && !checkoutExistingBranch && remoteTrackingBase
      ? await refreshLocalBaseRefForRemoteWorktreeCreate(provider, repo.path, remoteTrackingBase)
      : undefined

  const fsProvider = getSshFilesystemProvider(repo.connectionId!)
  if (fsProvider) {
    const primaryHooks = await readRemoteEffectiveHooks(repo, fsProvider, repo.path)
    if (primaryHooks?.scripts.setup) {
      shouldRunSetupForCreate(repo, args.setupDecision)
    }
  }

  let preparedPushTarget: GitPushTarget | undefined
  if (args.pushTarget) {
    // Why: fork-PR SSH worktrees need the same contributor-remote setup as
    // local worktrees before creation, otherwise Push/Sync can target origin.
    preparedPushTarget = await prepareWorktreePushTargetSsh(
      provider,
      repo.path,
      args.pushTarget,
      store,
      repo.id
    )
  }

  const mux = getActiveMultiplexer(repo.connectionId!)
  if (!mux) {
    throw new Error('SSH connection is not available. Please reconnect and try again.')
  }
  // Why: kept for back-compat with old relay binaries during the upgrade
  // window — those still gate git.addWorktree on registered roots, so we
  // must prime them synchronously to close fresh-host / reconnect windows.
  // New relays no-op these calls. Notify-fallback handles older relays that
  // pre-date the request-form session.registerRoot handler. Tracked for
  // removal once the relay-version floor moves past the cutover (see
  // docs/relay-fs-allowlist-removal.md).
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
    await provider.addWorktree(
      repo.path,
      branchName,
      remotePath,
      checkoutExistingBranch
        ? { checkoutExistingBranch }
        : { base: baseBranch, ...(sparseDirectories.length > 0 ? { noCheckout: true } : {}) }
    )
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes('No workspace roots registered yet') ||
        err.message.includes('Path outside authorized workspace'))
    ) {
      // Why: only an OLD relay binary (pre-allowlist-removal) can produce
      // these errors. New relays no-op session.registerRoot. Translate the
      // raw error into an actionable upgrade-window message while still
      // preserving the original string for bug reports. Tracked for removal
      // once the relay-version floor moves past the cutover (see
      // docs/relay-fs-allowlist-removal.md).
      throw new Error(
        `Older relay reported an authorization error; please reconnect to deploy the latest relay. (${err.message})`
      )
    }
    throw err
  }
  if (sparseDirectories.length > 0) {
    try {
      // Why: SSH providers expose generic git exec, so the remote sparse flow
      // can mirror local addSparseWorktree without adding a relay method.
      await provider.exec(['sparse-checkout', 'init', '--cone'], remotePath)
      await provider.exec(['sparse-checkout', 'set', '--', ...sparseDirectories], remotePath)
      await provider.exec(['checkout', branchName], remotePath)
    } catch (err) {
      if (!checkoutExistingBranch) {
        await unsetRemoteWorktreeCreationBase(provider, remotePath, branchName)
      }
      await provider.removeWorktree(remotePath, true).catch(() => undefined)
      throw err
    }
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
  let configuredPushTarget: GitPushTarget | undefined
  if (preparedPushTarget) {
    configuredPushTarget = await configureCreatedWorktreePushTargetSsh(
      provider,
      created.path,
      branchName,
      preparedPushTarget
    )
  }
  const metaUpdates: Partial<WorktreeMeta> = {
    // Why: path-derived worktree IDs can be reused after external deletion.
    // Fresh creations must rotate instance identity so stale lineage cannot
    // attach to the new occupant of the same path.
    instanceId: randomUUID(),
    lastActivityAt: now,
    // Why: grants the new worktree a short grace window at the top of the
    // Recent sort. During worktree creation (git fetch + add can take several
    // seconds) other worktrees get ambient PTY bumps that would otherwise
    // leave the newly-created one below them; the Recent comparator uses
    // max(lastActivityAt, createdAt + GRACE_MS) to keep it on top until the
    // window elapses. See smart-sort.ts `CREATE_GRACE_MS`.
    createdAt: now,
    orcaCreatedAt: now,
    orcaCreationSource: 'ssh',
    orcaCreationWorkspaceLayout: {
      path: settings.workspaceDir,
      nestWorkspaces: settings.nestWorkspaces
    },
    baseRef: baseBranch,
    ...(checkoutExistingBranch ? { preserveBranchOnDelete: true } : {}),
    ...(configuredPushTarget ? { pushTarget: configuredPushTarget } : {}),
    ...(requestedDisplayName
      ? { displayName: requestedDisplayName }
      : shouldSetDisplayName(requestedName, branchName, sanitizedName)
        ? { displayName: requestedName }
        : {}),
    ...(isTuiAgent(args.createdWithAgent) ? { createdWithAgent: args.createdWithAgent } : {}),
    ...(sparseDirectories.length > 0
      ? {
          sparseDirectories,
          sparseBaseRef: baseBranch,
          sparsePresetId
        }
      : {}),
    ...(args.linkedIssue !== undefined ? { linkedIssue: args.linkedIssue } : {}),
    ...(args.linkedPR !== undefined ? { linkedPR: args.linkedPR } : {}),
    ...(args.linkedLinearIssue !== undefined ? { linkedLinearIssue: args.linkedLinearIssue } : {}),
    ...(args.manualOrder !== undefined ? { manualOrder: args.manualOrder } : {}),
    ...(args.linkedGitLabIssue !== undefined ? { linkedGitLabIssue: args.linkedGitLabIssue } : {}),
    ...(args.linkedGitLabMR !== undefined ? { linkedGitLabMR: args.linkedGitLabMR } : {}),
    ...(args.workspaceStatus !== undefined ? { workspaceStatus: args.workspaceStatus } : {})
  }
  const meta = store.setWorktreeMeta(worktreeId, metaUpdates)
  const worktree = mergeWorktree(repo.id, created, meta)

  // Why: `experimentalWorktreeSymlinks` is intentionally not wired up for
  // remote (SSH) worktrees. Creating symlinks on the remote host would
  // require a new relay method and authorization surface; the feature is
  // local-only until that protocol work is in scope. Remote repos with
  // `symlinkPaths` configured have them silently ignored here.

  let setup: CreateWorktreeResult['setup']
  if (fsProvider) {
    const hooks = await readRemoteEffectiveHooks(repo, fsProvider, created.path)
    const setupScript = hooks?.scripts.setup
    let shouldLaunchSetup = false
    if (setupScript) {
      try {
        shouldLaunchSetup = shouldRunSetupForCreate(repo, args.setupDecision)
      } catch (error) {
        // Why: the remote worktree already exists. If the created branch adds
        // a setup hook without a renderer decision, skip setup instead of
        // reporting successful git creation as failed.
        console.warn(`[hooks] setup hook skipped for ${created.path}:`, error)
      }
    }
    if (setupScript && shouldLaunchSetup) {
      try {
        setup = await createRemoteSetupRunnerScript(
          repo,
          created.path,
          setupScript,
          provider,
          fsProvider
        )
      } catch (error) {
        console.error(`[hooks] Failed to prepare setup runner for ${created.path}:`, error)
      }
    }
  }

  notifyWorktreesChanged(mainWindow, repo.id)
  return {
    worktree,
    ...(setup ? { setup } : {}),
    ...(localBaseRefRefresh ? { localBaseRefRefresh } : {})
  }
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
  const requestedDisplayName = args.displayName
    ? sanitizeWorktreeDisplayName(args.displayName)
    : undefined

  // Why: resolve the base before branch/path selection so remote-tracking bases
  // can be refreshed before `git worktree add`. Creating first and repairing
  // later races setup scripts, agents, and user edits.
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

  let remoteTrackingBase: RemoteTrackingBase | null = null
  let remoteTrackingRefresh: {
    base: RemoteTrackingBase
    hadLocalBaseRef: boolean
    promise: Promise<RemoteFetchResult>
  } | null = null
  let legacyFetchPromise: Promise<void> | null = null

  if (runtime) {
    remoteTrackingBase = await runtime.resolveRemoteTrackingBase(repo.path, baseBranch)
    if (remoteTrackingBase) {
      const hasLocalBaseRef = await runtime.hasRemoteTrackingRef(repo.path, remoteTrackingBase)
      emitCreateWorktreeProgress(mainWindow, 'fetching')
      remoteTrackingRefresh = {
        base: remoteTrackingBase,
        hadLocalBaseRef: hasLocalBaseRef,
        promise: runtime.getOrStartRemoteTrackingBaseRefresh(repo.path, remoteTrackingBase)
      }
    } else {
      // Why: when the base branch does not match a configured remote prefix
      // (e.g. plain `main`, `master`, or any local branch), the legacy path
      // still ran a best-effort `git fetch origin` so a local base could be
      // built against fresher tracking refs. Preserve that behavior here so
      // local-only bases don't silently skip the pre-create fetch.
      const fallbackRemote = baseBranch.includes('/') ? baseBranch.split('/')[0] : 'origin'
      legacyFetchPromise = runtime
        .fetchRemoteWithCache(repo.path, fallbackRemote)
        .then(() => undefined)
        .catch(() => undefined)
      emitCreateWorktreeProgress(mainWindow, 'fetching')
    }
  } else {
    const remote = baseBranch.includes('/') ? baseBranch.split('/')[0] : 'origin'
    legacyFetchPromise = gitExecFileAsync(['fetch', remote], { cwd: repo.path })
      .then(() => undefined)
      .catch(() => undefined)
    emitCreateWorktreeProgress(mainWindow, 'fetching')
  }
  // Why: WSL worktrees live under ~/orca/workspaces inside the WSL
  // filesystem. Validate against that root, not the Windows workspace dir.
  // If WSL home lookup fails, keep using the configured workspace root so
  // the path traversal guard still runs on the fallback path.
  const wslInfo = isWslPath(repo.path) ? parseWslPath(repo.path) : null
  const wslHome = wslInfo ? getWslHome(wslInfo.distro) : null
  const workspaceRoot = wslHome ? join(wslHome, 'orca', 'workspaces') : settings.workspaceDir

  // Why: this validation does not depend on remote refs, so it can overlap a
  // required remote-tracking base refresh.
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
  let checkoutExistingBranch = false
  let selectedExistingLocalBranchName: string | null = null
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

    branchName = await resolveCreateBranchName(
      repo.path,
      selectedExistingLocalBranchName
        ? selectedExistingLocalBranchName
        : suffix === 1 && args.branchNameOverride
          ? args.branchNameOverride
          : args.branchNameOverride
            ? `${args.branchNameOverride}-${suffix}`
            : undefined,
      effectiveSanitizedName,
      settings,
      username
    )
    checkoutExistingBranch = await canCheckoutExistingLocalBranch(repo.path, branchName, baseBranch)
    if (checkoutExistingBranch && !selectedExistingLocalBranchName) {
      // Why: suffix retries may need a new path, but an existing branch checkout
      // must keep using the user-selected branch instead of creating a sibling.
      selectedExistingLocalBranchName = branchName
    }
    lastBranchConflictKind = checkoutExistingBranch
      ? null
      : await getBranchConflictKind(repo.path, branchName, baseBranch)
    if (lastBranchConflictKind) {
      continue
    }

    // Why: `gh pr list` is a network round-trip that previously ran on every
    // create, adding ~1–3s to the happy path even when no conflict exists. We
    // only probe PR conflicts once a local/remote branch collision has already
    // forced us past the first suffix — at that point uniqueness matters
    // enough to justify the GitHub call. The common case (brand-new branch
    // name, no collisions) skips the network entirely.
    if (suffix > 1 && !checkoutExistingBranch) {
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

  if (remoteTrackingRefresh) {
    const result = await remoteTrackingRefresh.promise
    if (!result.ok) {
      throw new Error(
        `Could not refresh base ref "${baseBranch}" from "${remoteTrackingRefresh.base.remote}". Check your network and try again.`
      )
    }
    if (
      !remoteTrackingRefresh.hadLocalBaseRef &&
      !(await runtime?.hasRemoteTrackingRef(repo.path, remoteTrackingRefresh.base))
    ) {
      throw new Error(`Base ref "${baseBranch}" was not found after fetching.`)
    }
  }

  if (legacyFetchPromise) {
    await legacyFetchPromise
  }
  emitCreateWorktreeProgress(mainWindow, 'creating')

  let preparedPushTarget: GitPushTarget | undefined
  if (args.pushTarget) {
    // Why: validate and fetch the contributor remote before creating the
    // worktree. If this fails, retrying won't hit branch/path conflicts from a
    // half-created worktree.
    preparedPushTarget = await prepareWorktreePushTarget(repo.path, args.pushTarget, store, repo.id)
  }

  const existingBranchOption = { checkoutExistingBranch }
  const addResult: AddWorktreeResult =
    (await (sparseDirectories.length > 0
      ? checkoutExistingBranch
        ? addSparseWorktree(
            repo.path,
            worktreePath,
            branchName,
            sparseDirectories,
            baseBranch,
            settings.refreshLocalBaseRefOnWorktreeCreate,
            existingBranchOption
          )
        : addSparseWorktree(
            repo.path,
            worktreePath,
            branchName,
            sparseDirectories,
            baseBranch,
            settings.refreshLocalBaseRefOnWorktreeCreate
          )
      : checkoutExistingBranch
        ? addWorktree(
            repo.path,
            worktreePath,
            branchName,
            baseBranch,
            settings.refreshLocalBaseRefOnWorktreeCreate,
            false,
            existingBranchOption
          )
        : addWorktree(
            repo.path,
            worktreePath,
            branchName,
            baseBranch,
            settings.refreshLocalBaseRefOnWorktreeCreate
          ))) ?? {}

  let configuredPushTarget: GitPushTarget | undefined
  if (preparedPushTarget) {
    // Why: fork-PR review worktrees should publish commits back to the PR
    // author's branch. Configure the branch upstream immediately so the
    // existing Push/Pull/Sync controls use the contributor remote instead of
    // silently defaulting to origin.
    configuredPushTarget = await configureCreatedWorktreePushTarget(
      worktreePath,
      branchName,
      preparedPushTarget
    )
  }

  // Re-list to get the freshly created worktree info
  const gitWorktrees = await listWorktrees(repo.path)
  const created = gitWorktrees.find((gw) => areWorktreePathsEqual(gw.path, worktreePath))
  if (!created) {
    throw new Error('Worktree created but not found in listing')
  }

  const worktreeId = `${repo.id}::${created.path}`
  const now = Date.now()
  const metaUpdates: Partial<WorktreeMeta> = {
    // Why: path-derived worktree IDs can be reused after external deletion.
    // Fresh creations must rotate instance identity so stale lineage cannot
    // attach to the new occupant of the same path.
    instanceId: randomUUID(),
    // Stamp activity so the worktree sorts into its final position
    // immediately — prevents scroll-to-reveal racing with a later
    // bumpWorktreeActivity that would re-sort the list.
    lastActivityAt: now,
    // See createRemoteWorktree above: createdAt protects the newly-created
    // worktree from ambient PTY bumps in other worktrees for CREATE_GRACE_MS.
    createdAt: now,
    orcaCreatedAt: now,
    orcaCreationSource: 'desktop',
    orcaCreationWorkspaceLayout: {
      path: settings.workspaceDir,
      nestWorkspaces: settings.nestWorkspaces
    },
    baseRef: baseBranch,
    ...(checkoutExistingBranch ? { preserveBranchOnDelete: true } : {}),
    ...(configuredPushTarget ? { pushTarget: configuredPushTarget } : {}),
    ...(requestedDisplayName
      ? { displayName: requestedDisplayName }
      : shouldSetDisplayName(effectiveRequestedName, branchName, effectiveSanitizedName)
        ? { displayName: effectiveRequestedName }
        : {}),
    ...(sparseDirectories.length > 0
      ? {
          sparseDirectories,
          sparseBaseRef: baseBranch,
          sparsePresetId
        }
      : {}),
    ...(isTuiAgent(args.createdWithAgent) ? { createdWithAgent: args.createdWithAgent } : {}),
    ...(args.linkedIssue !== undefined ? { linkedIssue: args.linkedIssue } : {}),
    ...(args.linkedPR !== undefined ? { linkedPR: args.linkedPR } : {}),
    ...(args.linkedLinearIssue !== undefined ? { linkedLinearIssue: args.linkedLinearIssue } : {}),
    ...(args.manualOrder !== undefined ? { manualOrder: args.manualOrder } : {}),
    ...(args.linkedGitLabIssue !== undefined ? { linkedGitLabIssue: args.linkedGitLabIssue } : {}),
    ...(args.linkedGitLabMR !== undefined ? { linkedGitLabMR: args.linkedGitLabMR } : {}),
    ...(args.workspaceStatus !== undefined ? { workspaceStatus: args.workspaceStatus } : {})
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
    ...(setup ? { setup } : {}),
    ...(addResult.localBaseRefRefresh ? { localBaseRefRefresh: addResult.localBaseRefRefresh } : {})
  }
}
