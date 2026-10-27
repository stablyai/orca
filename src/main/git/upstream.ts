import type { GitUpstreamStatus } from '../../shared/git-status-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import { upstreamOnlyCommitsArePatchEquivalent } from '../../shared/git-upstream-status'
import { isNoUpstreamError, normalizeGitErrorMessage } from '../../shared/git-remote-error'
import { getEffectiveGitUpstreamStatus } from '../../shared/git-effective-upstream'
import { getPublishTargetStatus } from '../../shared/git-publish-target-status'
import { gitExecFileAsync } from './runner'
import { validateGitPushTarget } from './push-target-validation'
import { nativeAndWslGitUpstreamStatusReadOwner } from './git-upstream-status-read-owner'
import type { GitAdmissionTier } from './command-runner/git-exec-options'

type GitExecOptions = {
  wslDistro?: string
  admissionTier?: GitAdmissionTier
}

export function invalidateGitUpstreamStatusReads(): void {
  nativeAndWslGitUpstreamStatusReadOwner.invalidate()
}

function gitExecOptions(
  cwd: string,
  options: GitExecOptions = {}
): { cwd: string; wslDistro?: string; admissionTier?: GitAdmissionTier } {
  return {
    cwd,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.admissionTier ? { admissionTier: options.admissionTier } : {})
  }
}

async function getBehindCommitsArePatchEquivalent(
  worktreePath: string,
  upstreamName: string,
  options: GitExecOptions = {}
): Promise<boolean> {
  try {
    const { stdout } = await gitExecFileAsync(
      [
        'log',
        '--no-show-signature',
        '--no-color',
        '--oneline',
        '--cherry-mark',
        '--right-only',
        `HEAD...${upstreamName}`,
        '--'
      ],
      gitExecOptions(worktreePath, options)
    )
    return upstreamOnlyCommitsArePatchEquivalent(stdout)
  } catch {
    // Failed patch-equivalence probes retain the conservative pull-first behavior.
    return false
  }
}

async function readUpstreamStatus(
  worktreePath: string,
  pushTarget?: GitPushTarget,
  options: GitExecOptions = {}
): Promise<GitUpstreamStatus> {
  try {
    if (pushTarget) {
      const target = await validateGitPushTarget(worktreePath, pushTarget, options)
      return await getPublishTargetStatus(
        (args) => gitExecFileAsync(args, gitExecOptions(worktreePath, options)),
        target,
        (upstreamName) => getBehindCommitsArePatchEquivalent(worktreePath, upstreamName, options)
      )
    }
    return await getEffectiveGitUpstreamStatus(
      (args) => gitExecFileAsync(args, gitExecOptions(worktreePath, options)),
      (upstreamName) => getBehindCommitsArePatchEquivalent(worktreePath, upstreamName, options)
    )
  } catch (error) {
    // Suppress only proven no-upstream errors; auth, corruption and unavailable repos must surface.
    if (isNoUpstreamError(error)) {
      return {
        hasUpstream: false,
        ahead: 0,
        behind: 0
      }
    }
    // Normalize before IPC so renderer errors omit subprocess preambles and local paths.
    throw new Error(normalizeGitErrorMessage(error, 'upstream'))
  }
}

export function getUpstreamStatus(
  worktreePath: string,
  pushTarget?: GitPushTarget,
  options: GitExecOptions = {}
): Promise<GitUpstreamStatus> {
  const executionIdentity = options.wslDistro
    ? ({ kind: 'wsl', distro: options.wslDistro } as const)
    : ({ kind: 'native' } as const)
  return nativeAndWslGitUpstreamStatusReadOwner.read(
    executionIdentity,
    worktreePath,
    pushTarget,
    () => readUpstreamStatus(worktreePath, pushTarget, options)
  )
}
