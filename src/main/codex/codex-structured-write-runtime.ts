import { join } from 'node:path'
import { CodexStructuredWriteAuthority } from './codex-structured-write-authority'
import { CodexStructuredWriteLeaseRegistry } from './codex-structured-write-lease-registry'
import { CodexStructuredWriteReceiptStore } from './codex-structured-write-receipt-store'
import { LOCAL_STRUCTURED_WRITE_EFFECT } from './codex-structured-write-types'

export async function createCodexStructuredWriteAuthority(input: {
  stateDirectory: string
  onTraceError?: (error: unknown) => void
}): Promise<CodexStructuredWriteAuthority> {
  const store = await CodexStructuredWriteReceiptStore.open(
    join(input.stateDirectory, 'codex-structured-write'),
    input.onTraceError
  )
  const registry = new CodexStructuredWriteLeaseRegistry({
    admitTurn: (turn) => {
      const authority = turn.requestAuthority
      if (
        !authority ||
        authority.effectAuthority !== LOCAL_STRUCTURED_WRITE_EFFECT ||
        !/^[0-9a-f]{64}$/.test(authority.requestReceiptId) ||
        store.hasAdmission(turn.sessionId, turn.clientMessageId)
      ) {
        return null
      }
      return {
        requestReceiptId: authority.requestReceiptId,
        writableRoot: turn.writableRoot
      }
    },
    persistAdmission: (receipt) => store.persistAdmission(receipt),
    persistOutcome: (receipt) => store.persistOutcome(receipt),
    flushReceipts: () => store.flush(),
    onOutcomePersistenceFailure: ({ error }) => input.onTraceError?.(error)
  })
  return new CodexStructuredWriteAuthority(registry)
}
