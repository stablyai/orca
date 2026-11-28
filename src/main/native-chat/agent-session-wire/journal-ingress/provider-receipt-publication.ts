import { isNativeLocalLocation } from '../../../../shared/execution-host/execution-host'
import {
  isAgentSessionReceiptProvider,
  type AgentSessionReceiptProvider
} from '../../../../shared/agent-session/journal/agent-session-dispatch-limits'
import type { AgentSessionAttachParams } from '../acquisition/structured-agent-session-attach'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { StructuredAgentSessionCommandHandoverContext } from '../operations/structured-agent-session-command-turn'

export type ProviderReceiptInput = { beginProviderReceipt?: BeginProviderReceipt }
export type ProviderReceiptConfirmation = ((isPending: () => boolean) => void) & {
  cancel: () => void
}
export type BeginProviderReceipt = () => ProviderReceiptConfirmation | undefined

/** Optional delivery status cannot fail the provider frame or send it accompanies. */
export function withProviderReceipt<T>(publish: () => T): T | undefined {
  try {
    return publish()
  } catch {
    return undefined
  }
}

export function localReceiptProvider({
  location,
  provider
}: Pick<AgentSessionAttachParams, 'location' | 'provider'>):
  | AgentSessionReceiptProvider
  | undefined {
  return isNativeLocalLocation(location) && isAgentSessionReceiptProvider(provider)
    ? provider
    : undefined
}

export function localProviderReceipt(
  ctx: Pick<
    StructuredAgentSessionCommandHandoverContext,
    'providerReceipts' | 'journal' | 'record' | 'fence'
  >,
  clientMessageId: string,
  isCurrent?: () => boolean,
  signal?: AbortSignal
):
  | ((cursor: AgentJournalCursor, claudeUuidUnused?: boolean) => ReturnType<BeginProviderReceipt>)
  | undefined {
  const { providerReceipts, journal, record } = ctx
  const provider = journal.identity.agent
  if (
    !providerReceipts?.hasReaderAtHead(journal, ctx.fence) ||
    !isCurrent ||
    !isAgentSessionReceiptProvider(provider)
  ) {
    return undefined
  }
  return (cursor, claudeUuidUnused = true) =>
    withProviderReceipt(() => {
      const fence = ctx.fence
      if (provider === 'claude' && !claudeUuidUnused) {
        return undefined
      }
      return providerReceipts.bind({
        journal,
        clientMessageId,
        cursor,
        fence,
        provider,
        readFence: () => record()?.lease.runtimeFence,
        owns: () =>
          !signal?.aborted &&
          ctx.fence === fence &&
          isCurrent() &&
          record()?.lease.runtimeFence === fence
      })
    })
}

export function providerHandoverReceipt(
  ctx: StructuredAgentSessionCommandHandoverContext,
  clientMessageId: string,
  isCurrent: () => boolean,
  signal?: AbortSignal
) {
  const receipt = localProviderReceipt(ctx, clientMessageId, isCurrent, signal)
  if (!receipt) {
    return undefined
  }
  let cursor: AgentJournalCursor | undefined
  let uuidUnused: boolean | undefined
  let confirmation: ProviderReceiptConfirmation | undefined
  let begun = false
  return {
    committed: (next: { dispatchCursor?: AgentJournalCursor; firstHandover: boolean }) => {
      cursor = next.dispatchCursor
      confirmation = undefined
      begun = false
      uuidUnused ??= next.firstHandover
    },
    begin: () => {
      if (!begun && cursor) {
        begun = true
        const receive = receipt(cursor, uuidUnused === true)
        if (ctx.journal.identity.agent === 'claude') {
          uuidUnused = false
          return receive
        }
        confirmation = receive
        uuidUnused = false
      }
      return confirmation
    }
  }
}
