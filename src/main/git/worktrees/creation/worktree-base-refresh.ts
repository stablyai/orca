import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type {
  LocalBaseRefRefreshResult,
  LocalBaseRefUpdateSuggestion
} from '../../../../shared/worktree/base-refs/base-ref-drift-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import { createCoalescingKeyedRunner } from '../../../../shared/concurrency/coalescing-keyed-runner'
import { parseWorktreeList } from '../../../../shared/git/worktrees/git-worktree-porcelain-parser'
import {
  fastForwardCheckedOutLocalBaseBranch,
  fastForwardLocalBaseBranch,
  inspectLocalBaseBranch,
  toLocalBaseRefRefreshResult,
  type LocalBaseBranchFastForwardOutcome,
  type LocalBaseBranchGit
} from '../../../../shared/worktree/base-refs/local-base-branch-fast-forward'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import {
  translateWslOutputPath,
  translateWslOutputPaths
} from '../../command-runner/host-routing/wsl-path-translation'
import { routeLocalGitOptions } from '../../command-runner/host-routing/local-git-runtime-route'
import type { GitExecOptions } from '../../command-runner/git-exec-options'
import { runWithGitReadCacheInvalidation } from '../../source-control/git-read-cache-invalidation'
import type { AddWorktreeOptions, GitWorktreeExecOptions } from '../worktree-operation-options'

// Bound the create's wait on the shared ref-only refresh.
export const LOCAL_BASE_REF_REFRESH_WAIT_MS = 30_000

// Serialize per branch to avoid ref-lock races; coalesce only matching targets.
const runPerLocalBaseBranch = createCoalescingKeyedRunner<LocalBaseBranchFastForwardOutcome>()

// One checkout fast-forward per repo; creates during one share a single follow-up to the latest remote ref.
const runPerRepoCheckoutFastForward = createCoalescingKeyedRunner<void>()

export function parseRemoteTrackingLocalBaseRef(
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase']
): { baseRef: string; localBranch: string; fullRef: string } | undefined {
  if (remoteTrackingBase?.ref === remoteTrackingRef) {
    return {
      baseRef: remoteTrackingBase.base,
      localBranch: remoteTrackingBase.branch,
      fullRef: `refs/heads/${remoteTrackingBase.branch}`
    }
  }

  const remoteRefPrefix = 'refs/remotes/'
  if (!remoteTrackingRef.startsWith(remoteRefPrefix)) {
    return undefined
  }

  // Only proven remote-tracking refs warrant refresh warnings, not slash-named local branches.
  const shortRemoteRef = remoteTrackingRef.slice(remoteRefPrefix.length)
  const slashIndex = shortRemoteRef.indexOf('/')
  if (slashIndex <= 0) {
    return undefined
  }

  const localBranch = shortRemoteRef.slice(slashIndex + 1)
  return {
    baseRef: baseBranch,
    localBranch,
    fullRef: `refs/heads/${localBranch}`
  }
}

export async function refreshLocalBaseRefForWorktreeCreate(
  repoPath: string,
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase'],
  options: GitWorktreeExecOptions = {}
): Promise<LocalBaseRefRefreshResult | undefined> {
  const parsed = parseRemoteTrackingLocalBaseRef(baseBranch, remoteTrackingRef, remoteTrackingBase)
  if (!parsed) {
    return undefined
  }
  const key = `${options.wslDistro ?? ''}\0${normalizeRuntimePathForComparison(repoPath)}\0${parsed.fullRef}`
  const git = localBaseBranchGit(options)
  const outcome = await waitAtMost(
    // The shared run may outlive its create, so it owns cache invalidation.
    runPerLocalBaseBranch(key, remoteTrackingRef, () =>
      runWithGitReadCacheInvalidation(() =>
        fastForwardLocalBaseBranch(git, { repoPath, fullRef: parsed.fullRef, remoteTrackingRef })
      )
    ),
    LOCAL_BASE_REF_REFRESH_WAIT_MS
  )
  if (!outcome) {
    console.warn(
      `addWorktree: stopped waiting for the local ${parsed.localBranch} refresh after ${LOCAL_BASE_REF_REFRESH_WAIT_MS}ms`
    )
  }
  return toLocalBaseRefRefreshResult(parsed, outcome)
}

/** Fast-forward a checked-out base in its own checkout once a create is done; nothing waits on it. */
export function fastForwardCheckedOutLocalBaseAfterCreate(
  repoPath: string,
  baseBranch: string,
  remoteTrackingRef: string,
  options: AddWorktreeOptions
): void {
  const parsed = parseRemoteTrackingLocalBaseRef(
    baseBranch,
    remoteTrackingRef,
    options.remoteTrackingBase
  )
  if (!parsed) {
    return
  }
  const key = `${options.wslDistro ?? ''}\0${normalizeRuntimePathForComparison(repoPath)}`
  // Admission-exempt (bounded by the per-repo runner) so a stalled checkout never holds a slot creates wait on; no deadline, since killing a merge mid-checkout strands a half-updated tree.
  const git = localBaseBranchGit(options, { admissionExempt: true })
  void runPerRepoCheckoutFastForward(key, parsed.fullRef, () =>
    runWithGitReadCacheInvalidation(() =>
      fastForwardCheckedOutLocalBaseBranch(git, {
        repoPath,
        fullRef: parsed.fullRef,
        remoteTrackingRef
      })
    )
  ).catch((error: unknown) => {
    console.warn('addWorktree: checked-out local base fast-forward failed unexpectedly', error)
  })
}

export async function getLocalBaseRefUpdateSuggestionForWorktreeCreate(
  repoPath: string,
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase'],
  options: GitWorktreeExecOptions = {}
): Promise<LocalBaseRefUpdateSuggestion | undefined> {
  const parsed = parseRemoteTrackingLocalBaseRef(baseBranch, remoteTrackingRef, remoteTrackingBase)
  if (!parsed) {
    return undefined
  }
  const inspection = await inspectLocalBaseBranch(localBaseBranchGit(options), {
    repoPath,
    fullRef: parsed.fullRef,
    remoteTrackingRef
  })
  return inspection.status === 'behind'
    ? { baseRef: parsed.baseRef, localBranch: parsed.localBranch, behind: inspection.behind }
    : undefined
}

function localBaseBranchGit(
  options: GitWorktreeExecOptions,
  admission: Pick<GitExecOptions, 'admissionExempt'> = {}
): LocalBaseBranchGit {
  // Shared refreshes cannot use any individual create's cancellation signal or timeout.
  const execOptions = (cwd: string): GitExecOptions => ({
    cwd,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.admissionTier ? { admissionTier: options.admissionTier } : {}),
    ...admission
  })
  // The runner may route a Windows drive repo into WSL; its Linux output paths need the same distro.
  const routed = (cwd: string) => routeLocalGitOptions({ cwd, wslDistro: options.wslDistro })
  const listWorktrees = async (repoPath: string) => {
    const { stdout } = await withRepositoryGitCause(
      repoPath,
      options,
      { family: 'catalog', reason: 'creation-base-refresh', cache: 'uncached' },
      () => gitExecFileAsync(['worktree', 'list', '--porcelain'], execOptions(repoPath))
    )
    return parseWorktreeList(translateWslOutputPaths(stdout, repoPath, routed(repoPath)))
  }
  const commonDirOf = async (repoPath: string) => {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--git-common-dir'],
      execOptions(repoPath)
    )
    // Only strip the line ending: a path may end in spaces.
    const commonDir = stdout.replace(/\r?\n$/, '')
    return isAbsolute(commonDir)
      ? translateWslOutputPath(commonDir, repoPath, routed(repoPath))
      : join(repoPath, commonDir)
  }
  return {
    exec: (args, cwd) => gitExecFileAsync(args, execOptions(cwd)),
    listWorktrees,
    listReservedBranches: async (repoPath) =>
      (await readGitDirState(await commonDirOf(repoPath))).reserved,
    updateRefUnlessInUse: async (repoPath, fullRef, args) => {
      const commonDir = await commonDirOf(repoPath)
      const worktrees = await listWorktrees(repoPath)
      if (worktrees.some((wt) => wt.branch === fullRef)) {
        return false
      }
      // A bare repo's own HEAD names a branch without checking it out.
      const bareCommonDir = worktrees[0]?.isBare === true
      let inUse = false
      try {
        await gitExecFileAsync(args, {
          ...execOptions(repoPath),
          beforeStart: async () => {
            const { heads, reserved } = await readGitDirState(commonDir)
            inUse =
              reserved.has(fullRef) ||
              [...heads].some(
                ([gitDir, head]) =>
                  !(bareCommonDir && gitDir === commonDir) &&
                  // Reftable keeps HEAD elsewhere and leaves this placeholder: fail closed.
                  (head === `ref: ${fullRef}` || head === 'ref: refs/heads/.invalid')
              )
            return !inUse
          }
        })
      } catch (error) {
        if (inUse) {
          return false
        }
        throw error
      }
      return true
    }
  }
}

type GitDirState = {
  /** Each git dir's HEAD file, keyed by git dir. */
  heads: ReadonlyMap<string, string>
  /** Branches a rebase (head-name, --update-refs) or bisect reserves: Git's own in-use rule. */
  reserved: ReadonlySet<string>
}

// Reads files only: this runs inside an admitted command, where running Git could wait on its own slot.
async function readGitDirState(commonDir: string): Promise<GitDirState> {
  // Fail closed: an unreadable common dir must not look like "nothing in use".
  if (!(await stat(commonDir)).isDirectory()) {
    throw new Error(`${commonDir} is not a Git directory`)
  }
  const gitDirs = [commonDir]
  try {
    for (const entry of await readdir(join(commonDir, 'worktrees'), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        gitDirs.push(join(commonDir, 'worktrees', entry.name))
      }
    }
  } catch (error) {
    rethrowUnlessMissing(error)
  }
  const heads = new Map<string, string>()
  const reserved = new Set<string>()
  await Promise.all(
    gitDirs.map(async (gitDir) => {
      const [head, rebaseMerge, rebaseApply, updateRefs, bisectStart] = await Promise.all([
        readOptional(join(gitDir, 'HEAD')),
        readOptional(join(gitDir, 'rebase-merge', 'head-name')),
        readOptional(join(gitDir, 'rebase-apply', 'head-name')),
        readOptional(join(gitDir, 'rebase-merge', 'update-refs')),
        readOptional(join(gitDir, 'BISECT_START'))
      ])
      heads.set(gitDir, head.trim())
      for (const line of [rebaseMerge, rebaseApply, updateRefs].flatMap((text) =>
        text.split('\n')
      )) {
        if (line.startsWith('refs/heads/')) {
          reserved.add(line.trim())
        }
      }
      const bisected = bisectStart.trim()
      if (bisected) {
        reserved.add(bisected.startsWith('refs/') ? bisected : `refs/heads/${bisected}`)
      }
    })
  )
  return { heads, reserved }
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    rethrowUnlessMissing(error)
    return ''
  }
}

function rethrowUnlessMissing(error: unknown): void {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  if (code !== 'ENOENT' && code !== 'ENOTDIR') {
    throw error
  }
}

function waitAtMost<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}
import { withRepositoryGitCause } from '../../repository-git-cause'
