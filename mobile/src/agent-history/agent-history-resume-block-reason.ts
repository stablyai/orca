import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId
} from '../../../src/shared/execution-host'
import { antigravitySessionOrigin } from '../../../src/shared/antigravity-session-origin'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import { isWslUncPath } from '../../../src/shared/wsl-paths'
import type {
  MobileAiVaultResumeTargetStatus,
  MobileAiVaultResumeWorkspaceTarget
} from './agent-history-resume-target'

export type MobileAiVaultResumeBlockReason =
  | 'ssh-host-local'
  | 'ssh-other-host'
  | 'ssh-transcript-missing'
  | 'status'

export function getMobileAiVaultResumeTargetBlockReason(args: {
  session: Pick<AiVaultSession, 'executionHostId' | 'filePath'>
  target: MobileAiVaultResumeWorkspaceTarget
}): MobileAiVaultResumeBlockReason | null {
  const { session, target } = args
  if (target.status === 'local') {
    return null
  }
  if (target.status !== 'ssh') {
    return 'status'
  }
  // Why: Antigravity IDE/2.0 history resumes by file reference, which an SSH
  // shell cannot open (mirror of desktop canResumeAiVaultSessionOnTarget).
  const origin = antigravitySessionOrigin(session.filePath)
  if (origin && origin !== 'antigravity-cli') {
    return 'ssh-host-local'
  }
  const sessionHostId = normalizeExecutionHostId(session.executionHostId)
  if (sessionHostId && target.hostId && sessionHostId === target.hostId) {
    return null
  }
  if (sessionHostId && sessionHostId !== LOCAL_EXECUTION_HOST_ID) {
    return 'ssh-other-host'
  }
  // Why: mobile lists only the serving host's own scan, so rows are tagged
  // local. A WSL-stored transcript is still reachable from an SSH shell into
  // that machine's WSL (SSH-to-local-WSL setups, #6270); other host-local
  // files do not exist on the remote filesystem.
  return isWslUncPath(session.filePath) ? null : 'ssh-host-local'
}

/**
 * True when an SSH resume is allowed only by the WSL-UNC guess, i.e. nothing proves the SSH host
 * holds the transcript. Same-host rows are proven by the scan that produced them.
 */
export function isMobileAiVaultWslFallbackResume(args: {
  session: Pick<AiVaultSession, 'executionHostId' | 'filePath'>
  target: MobileAiVaultResumeWorkspaceTarget
}): boolean {
  if (args.target.status !== 'ssh' || !isWslUncPath(args.session.filePath)) {
    return false
  }
  const sessionHostId = normalizeExecutionHostId(args.session.executionHostId)
  return !sessionHostId || sessionHostId === LOCAL_EXECUTION_HOST_ID
}

export function mobileAiVaultResumeTargetBlockMessage(
  status: MobileAiVaultResumeTargetStatus,
  reason: MobileAiVaultResumeBlockReason | null
): string {
  if (status === 'runtime') {
    return 'Resume from history is not available in runtime-hosted workspaces.'
  }
  if (reason === 'ssh-transcript-missing') {
    return 'This session was not found on the SSH host of this workspace, so it cannot be resumed here.'
  }
  if (reason === 'ssh-other-host') {
    return 'This session is stored on a different SSH host than this workspace, so it cannot be resumed here.'
  }
  if (status === 'ssh') {
    return 'This session is stored on the host machine, so it cannot be resumed in an SSH workspace. Open a local workspace for this project.'
  }
  return 'Open a local workspace before resuming a session.'
}
