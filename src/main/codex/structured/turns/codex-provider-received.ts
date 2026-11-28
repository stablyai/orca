import {
  withProviderReceipt,
  type ProviderReceiptInput
} from '../../../native-chat/agent-session-wire/journal-ingress/provider-receipt-publication'
import type { CodexTurnHost } from './codex-structured-turn-contract'

export function armCodexProviderReceipt(
  host: CodexTurnHost,
  input: ProviderReceiptInput & { clientMessageId: string }
): (() => void) | undefined {
  const receive = input.beginProviderReceipt?.()
  const id = input.clientMessageId
  const origin = receive && host.dispatchEchoes.requestOrigin(id)
  if (!receive || !origin) {
    return undefined
  }
  return () => {
    withProviderReceipt(() =>
      receive(() => host.dispatchEchoes.requestOrigin(id)?.sequence === origin.sequence)
    )
  }
}
