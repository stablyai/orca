import {
  ReceiptRead,
  type ProviderReceiptRead,
  type ProviderReceiptReader
} from '../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'
import type { ProviderReceiptDestination } from './provider-receipt-credits'
import type { ProviderReceiptReaders } from './provider-receipt-readers'

type ReceiptPortRequest =
  | { kind: 'drop' }
  | { kind: 'restart' }
  | { kind: 'read'; input: ProviderReceiptRead }

export function providerReceiptPortRequest(
  readers: ProviderReceiptReaders,
  endpoint: ProviderReceiptDestination,
  binding: { reader: ProviderReceiptReader; pending: boolean },
  current: boolean,
  data: unknown
): ReceiptPortRequest {
  if (binding.pending) {
    return { kind: 'drop' }
  }
  const input = ReceiptRead.safeParse(data)
  if (
    !input.success ||
    input.data.reader.id !== binding.reader.id ||
    input.data.reader.generation !== binding.reader.generation ||
    !readers.canContinue(endpoint, input.data.since)
  ) {
    return { kind: 'drop' }
  }
  return current && readers.canStartRead(endpoint, binding.reader)
    ? { kind: 'read', input: input.data }
    : { kind: 'restart' }
}
