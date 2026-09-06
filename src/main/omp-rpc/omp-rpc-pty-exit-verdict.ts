// Translates the caller-supplied PTY liveness answer (true/false/null) into the
// owner's exit-verdict vocabulary, so acquisition's proof gate speaks the SSH
// execution boundary's live/unverifiable/exited three verdicts and nothing else
// (docs/reference/ssh-execution-boundary.md). Split out of
// omp-rpc-chat-session-registry.ts, which is at its line budget.

import type { OmpRpcOwnerExitVerdict } from './omp-rpc-session-owner'

export function ptyExitVerdict(
  ptyId: string,
  isPtyAlive: (ptyId: string) => boolean | null
): OmpRpcOwnerExitVerdict {
  const alive = isPtyAlive(ptyId)
  if (alive === true) {
    return { status: 'live', reason: 'pty still running' }
  }
  if (alive === null) {
    return { status: 'unverifiable', reason: 'pty liveness could not be determined' }
  }
  return { status: 'exited' }
}
