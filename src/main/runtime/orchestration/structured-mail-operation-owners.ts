import type { OrchestrationDb } from './db'
import type { StructuredMailOperation } from './structured-pointer-operation-id'
import type {
  StructuredMailboxPointerHost,
  StructuredPointerTarget
} from './structured-mailbox-pointer-delivery'

export type StructuredMailOperationOwner = StructuredMailOperation & {
  sessionId: string
  contextClearOperationId: string | undefined
  mailboxHandle: string
  messageId: string
}

/** Keep ambiguous IDs only while their exact mail and context can still use them. */
export function pruneStructuredMailOperations(input: {
  db: OrchestrationDb
  mailboxHandle: string
  target: StructuredPointerTarget | null
  host: StructuredMailboxPointerHost
  operations: Map<string, StructuredMailOperationOwner>
  sendsInFlight: ReadonlyMap<string, unknown>
  key?: string
}): void {
  try {
    if (input.operations.size === 0) {
      return
    }
    const current =
      input.target && input.host.currentFence(input.target.sessionId) !== null
        ? {
            sessionId: input.target.sessionId,
            contextClearOperationId: input.host.currentContextClearOperationId(
              input.target.sessionId
            )
          }
        : null
    const entries =
      input.key === undefined
        ? input.operations
        : [[input.key, input.operations.get(input.key)] as const]
    for (const [key, owner] of entries) {
      if (!owner) {
        continue
      }
      if (owner.mailboxHandle !== input.mailboxHandle || input.sendsInFlight.has(key)) {
        continue
      }
      const obsolete =
        current &&
        (owner.sessionId !== current.sessionId ||
          owner.contextClearOperationId !== current.contextClearOperationId)
      const message = obsolete ? undefined : input.db.getMessageById(owner.messageId)
      if (obsolete || !message || message.read !== 0 || message.to_handle !== owner.mailboxHandle) {
        input.operations.delete(key)
      }
    }
  } catch (error) {
    console.warn('[orchestration] pruning mail operation ownership failed', error)
  }
}
