import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { StructuredAgentSessionCommandHandoverContext } from '../operations/structured-agent-session-command-turn'

export type ProviderReceiptInput = { beginProviderReceipt?: BeginProviderReceipt }
export type BeginProviderReceipt = () => ((isPending: () => boolean) => void) | undefined

/** Optional delivery status cannot fail the provider frame or send it accompanies. */
export function withProviderReceipt<T>(publish: () => T): T | undefined {
  try {
    return publish()
  } catch {
    return undefined
  }
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
  const { providerReceipts, journal } = ctx
  if (!providerReceipts || !isCurrent) {
    return undefined
  }
  const record = ctx.record()
  const provider = record?.provider
  if (
    !record ||
    record.location.executionHostId !== 'local' ||
    record.location.wslDistro !== null ||
    (provider !== 'claude' && provider !== 'codex')
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
        owns: () =>
          !signal?.aborted &&
          ctx.fence === fence &&
          isCurrent() &&
          ctx.record()?.lease.runtimeFence === fence
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
  return {
    committed: (next: { dispatchCursor?: AgentJournalCursor; firstHandover: boolean }) => {
      cursor = next.dispatchCursor
      uuidUnused ??= next.firstHandover
    },
    begin: () => {
      const unused = uuidUnused === true
      uuidUnused = false
      return cursor ? receipt(cursor, unused) : undefined
    }
  }
}
