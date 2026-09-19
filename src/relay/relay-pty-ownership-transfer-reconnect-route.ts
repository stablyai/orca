import type { RelayPtyOwnershipTransferRecord } from './relay-pty-ownership-transfer-adapter-state'

export function parseRelayPtyOwnershipTransferReconnectRoute(
  value: unknown,
  identity: RelayPtyOwnershipTransferRecord['identity']
): RelayPtyOwnershipTransferRecord['reconnectRoute'] {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidRoute()
  }
  const record = value as Record<string, unknown>
  if (
    !Number.isSafeInteger(record.generation) ||
    Number(record.generation) < identity.sourceOwnerGeneration ||
    typeof record.attachmentId !== 'string' ||
    record.attachmentId.length === 0
  ) {
    throw invalidRoute()
  }
  return Object.freeze({
    generation: Number(record.generation),
    attachmentId: record.attachmentId
  })
}

function invalidRoute(): Error {
  return new Error('pty_ownership_transfer_relay_journal_invalid')
}
