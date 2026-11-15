import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type {
  LocalBaseRefRefreshResult,
  LocalBaseRefUpdateSuggestion
} from '../../../../shared/worktree/base-refs/base-ref-drift-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { createCoalescingKeyedRunner } from '../../../../shared/coalescing-keyed-runner'
import { parseWorktreeList } from '../../../../shared/git/worktrees/git-worktree-porcelain-parser'
import {
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
import { acquireGitAdmission } from '../../command-runner/admission/git-subprocess-admission'
import { routeLocalGitOptions } from '../../command-runner/host-routing/local-git-runtime-route'
import { pendingWslDriveCheckoutGitRouting } from '../../command-runner/host-routing/wsl-drive-checkout-git-routing'
import { pendingWslDirectGitReadEnvironment } from '../../command-runner/host-routing/git-command-resolution'
import type { GitExecOptions } from '../../command-runner/git-exec-options'
import { runWithGitReadCacheInvalidation } from '../../source-control/git-read-cache-invalidation'
import type { AddWorktreeOptions, GitWorktreeExecOptions } from '../worktree-operation-options'

// Bound the create's wait on the shared ref-only refresh.
export const LOCAL_BASE_REF_REFRESH_WAIT_MS = 30_000

// Serialize per branch to avoid ref-lock races; coalesce only matching targets.
const runPerLocalBaseBranch = createCoalescingKeyedRunner<LocalBaseBranchFastForwardOutcome>()

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
  held?: Pick<GitExecOptions, 'admissionExempt' | 'observeChildTermination'>
): LocalBaseBranchGit {
  // The runner may route a Windows drive repo into WSL; its Linux output paths need the same distro.
  const routedFor = (cwd: string) => routeLocalGitOptions({ cwd, wslDistro: options.wslDistro })
  // Shared refreshes cannot use any individual create's cancellation signal or timeout.
  const execOptions = (cwd: string): GitExecOptions => ({
    cwd,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.admissionTier ? { admissionTier: options.admissionTier } : {}),
    ...held
  })
  return {
    exec: (args, cwd) => gitExecFileAsync(args, execOptions(cwd)),
    listWorktrees: async (repoPath) => {
      const { stdout } = await withRepositoryGitCause(
        repoPath,
        options,
        { family: 'catalog', reason: 'creation-base-refresh', cache: 'uncached' },
        () => gitExecFileAsync(['worktree', 'list', '--porcelain'], execOptions(repoPath))
      )
      return parseWorktreeList(translateWslOutputPaths(stdout, repoPath, routedFor(repoPath)))
    },
    listReservedBranches: async (repoPath) => {
      const { stdout } = await gitExecFileAsync(
        ['rev-parse', '--git-common-dir'],
        execOptions(repoPath)
      )
      // Only strip the line ending: a path may end in spaces.
      const commonDir = stdout.replace(/\r?\n$/, '')
      return readRebaseAndBisectReservations(
        isAbsolute(commonDir)
          ? translateWslOutputPath(commonDir, repoPath, routedFor(repoPath))
          : join(repoPath, commonDir)
      )
    },
    runExclusive: async (repoPath, work) => {
      const routed = routedFor(repoPath)
      // Settle WSL routing probes first: they take admission themselves and would wait on this grant.
      await pendingWslDriveCheckoutGitRouting(['update-ref'], routed)
      await pendingWslDirectGitReadEnvironment(['worktree', 'list', '--porcelain'], routed)
      const grant = await acquireGitAdmission({
        args: ['update-ref'],
        cwd: repoPath,
        wslDistro: routed.wslDistro,
        tier: options.admissionTier
      })
      const terminations: Promise<void>[] = []
      try {
        return await work(
          localBaseBranchGit(options, {
            admissionExempt: true,
            observeChildTermination: (terminated) => terminations.push(terminated)
          })
        )
      } finally {
        // Like any admitted command, hold the slot until every child has exited.
        void Promise.all(terminations).then(grant.release)
      }
    }
  }
}

// Git's own in-use rule: a rebase (head-name, --update-refs) or bisect in any worktree reserves its branch.
async function readRebaseAndBisectReservations(commonDir: string): Promise<ReadonlySet<string>> {
  // Fail closed: an unreadable common dir must not look like "nothing reserved".
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
  const reserved = new Set<string>()
  await Promise.all(
    gitDirs.map(async (gitDir) => {
      const [rebaseMerge, rebaseApply, updateRefs, bisectStart] = await Promise.all([
        readOptional(join(gitDir, 'rebase-merge', 'head-name')),
        readOptional(join(gitDir, 'rebase-apply', 'head-name')),
        readOptional(join(gitDir, 'rebase-merge', 'update-refs')),
        readOptional(join(gitDir, 'BISECT_START'))
      ])
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
  return reserved
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
  const code = (error as NodeJS.ErrnoException | null)?.code
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
