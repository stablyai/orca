import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import type { RuntimeWorktreeTerminalCloseResult } from '../../shared/runtime-types'

type WorktreePtyStopVerdict = Pick<
  RuntimeWorktreeTerminalCloseResult,
  'ptyStopVerdict' | 'ptyStopReason'
>

export function summarizeWorktreePtyStopVerdict(
  ptyIds: Iterable<string>,
  getVerdict: (ptyId: string) => PtyLivenessVerdict | null,
  isConnected: (ptyId: string) => boolean
): WorktreePtyStopVerdict {
  let ptyStopVerdict: 'live' | 'unverifiable' | undefined
  let ptyStopReason: string | undefined
  for (const ptyId of ptyIds) {
    const verdict = getVerdict(ptyId)
    if (verdict?.status === 'live') {
      return { ptyStopVerdict: 'live' }
    }
    if (verdict?.status === 'unverifiable') {
      ptyStopVerdict = 'unverifiable'
      ptyStopReason ??= verdict.reason
    } else if (isConnected(ptyId)) {
      ptyStopVerdict ??= 'unverifiable'
      ptyStopReason ??= 'the owning host did not confirm the PTY exit'
    }
  }
  return {
    ...(ptyStopVerdict ? { ptyStopVerdict } : {}),
    ...(ptyStopReason ? { ptyStopReason } : {})
  }
}
