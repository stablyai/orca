import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'

export type WorktreeRemovalInFlight = {
  optionsKey: string
  promise: Promise<RemoveWorktreeResult>
}

export function getWorktreeRemovalOptionsKey(
  args: Pick<RemoveWorktreeArgs, 'force' | 'allowUnverifiedPtyStop' | 'skipArchive'>
): string {
  const forceKey = args.force === true ? 'force' : 'normal'
  const archiveKey = args.skipArchive === true ? 'skip-archive' : 'run-archive'
  // Why: a Force Delete retry must not coalesce onto the in-flight attempt that
  // just failed the PTY gate — it would inherit that failure instead of retrying.
  const ptyKey = args.allowUnverifiedPtyStop === true ? 'allow-unverified-pty' : 'require-pty-stop'
  return `${forceKey}:${archiveKey}:${ptyKey}`
}

export function getWorktreeRemovalInFlightKey(
  worktreeId: string,
  hostId?: ExecutionHostId
): string {
  return `${hostId ?? ''}\0${worktreeId}`
}
