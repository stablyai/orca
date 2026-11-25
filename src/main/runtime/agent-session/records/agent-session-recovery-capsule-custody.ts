// Which sessions the restart recovery capsule holds anything for, and how: read under the capsule's
// own lock and normalized in memory only, so nothing is published, pruned or spent. A session it doesn't
// name holds nothing; a read that fails throws, which a caller must treat as unknown.
import { withFileTransactionLock } from '../../../filesystem/file-transaction-lock'
import type { AgentSessionRecoveryCapsule } from './agent-session-recovery-capsule'
import { normalizeState } from './agent-session-recovery-capsule-entries'
import { readRecoveryCapsuleState } from './agent-session-recovery-capsule-file'

export type RecoveryCustody = 'pending' | 'in-progress' | 'failed'

export function readRecoveryCapsuleCustody(
  capsule: Pick<AgentSessionRecoveryCapsule, 'filePath'>,
  now: number
): Promise<Map<string, RecoveryCustody>> {
  return withFileTransactionLock(capsule.filePath, async () => {
    const { entries, failed } = normalizeState(
      await readRecoveryCapsuleState(capsule.filePath),
      now
    )
    const held = new Map<string, RecoveryCustody>()
    for (const failure of failed) {
      held.set(failure.marker.sessionId, 'failed')
    }
    for (const entry of entries) {
      held.set(entry.marker.sessionId, entry.state)
      if (entry.state === 'in-progress' && entry.replacement) {
        held.set(entry.replacement.sessionId, 'in-progress')
      }
    }
    return held
  })
}
