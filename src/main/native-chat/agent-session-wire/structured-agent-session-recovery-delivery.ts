import type { ContextTransferState } from '../agent-session-journal/context-transfer-state'
import { deriveContextTransferState } from '../agent-session-journal/context-transfer-state'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { latestStructuredAgentContextFacts } from '../../../shared/agent-session/structured-agent-session-context-usage'
import { contextTokensFromUsage } from '../../../shared/agent-session/agent-session-context-usage'
import { providerTimelineKeyPart } from '../agent-session-timeline/provider-timeline-identity'
import { StructuredAgentSessionInputNotAdmitted } from './structured-agent-session-input-admission'
import { randomUUID } from 'node:crypto'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { ContextTransferDelivery } from '../agent-session-journal/context-transfer-record'
import type { AgentSessionHandoverContext } from './structured-agent-session-host-types'
import {
  RecoveryContextBudgetError,
  selectRecoveryDelivery,
  withRecoveryContext
} from '../agent-session-context-transfer-text'
import { toLinuxPath } from '../../../shared/wsl-paths'

export type PreparedRecoveryDelivery = {
  /** An injection must precede the carrier's pending row. */
  beforeCarrier: (
    commit: (run: () => Promise<void>) => Promise<void>,
    isCurrent: () => boolean
  ) => Promise<AgentJournalMessageItem>
}

/** All native I/O and optional export run outside conversation ordering; writes remain synchronous. */
export function prepareRecoveryDelivery(
  ctx: AgentSessionHandoverContext,
  clientMessageId: string,
  body: AgentJournalMessageItem,
  state: ContextTransferState,
  signal?: AbortSignal
): PreparedRecoveryDelivery {
  return {
    beforeCarrier: async (commit, isCurrent) => {
      const authorize = () => {
        signal?.throwIfAborted()
        if (!isCurrent() || ctx.record()?.lease.runtimeFence !== ctx.fence) {
          throw new Error('Context delivery lost its owner')
        }
        const current = deriveContextTransferState(
          ctx.journal.contextTransfers.facts(),
          ctx.record()?.providerHandleChain ?? []
        )
        if (
          current.kind === 'none' ||
          state.kind === 'none' ||
          current.target.id !== state.target.id
        ) {
          throw new StructuredAgentSessionInputNotAdmitted()
        }
      }
      const write = async (delivery: ContextTransferDelivery, starting = false) =>
        commit(async () => {
          if (starting) {
            authorize()
          }
          ctx.journal.contextTransfers.write(delivery)
        })
      const record = ctx.record()
      const head = agentSessionProviderHandleChainHead(record?.providerHandleChain ?? [])
      if (!head || !record) {
        return body
      }
      if (state.kind === 'none' || state.kind === 'settled') {
        return body
      }
      if (state.kind !== 'owed') {
        throw new StructuredAgentSessionInputNotAdmitted()
      }
      const { target, handoff } = state
      signal?.throwIfAborted()
      let transcriptPath: string | undefined
      try {
        const path = await ctx.journal.exportRecoveryContext(handoff)
        transcriptPath = path && record.location.wslDistro ? toLinuxPath(path) : path
      } catch {}
      signal?.throwIfAborted()
      const encoding = await ctx.adapter.historicalInputBytes?.({ sessionId: ctx.sessionId, body })
      const facts = ctx.journal.contextUsage()
      const native = latestStructuredAgentContextFacts(
        ctx.journal.snapshot().items.filter((item) => {
          const identity = parseAgentJournalItemKey(item.itemId)
          if (identity?.provider === 'codex' && head.handle.transport === 'codex-app-server') {
            return identity.threadId === head.handle.nativeId
          }
          if (identity?.provider !== 'legacy' || identity.agent !== head.handle.agent) {
            return false
          }
          if (head.handle.transport === 'acp') {
            return identity.recordId.startsWith(
              `item:p:${providerTimelineKeyPart(head.handle.nativeId)}:`
            )
          }
          return (
            head.handle.transport === 'jsonl-rpc' &&
            (identity.sessionId === head.handle.nativeId ||
              (identity.sessionId === ctx.sessionId &&
                ctx.journal.itemFence(item.itemId) === ctx.fence))
          )
        })
      )
      const modelWindow = Math.min(
        facts.window?.tokens ?? 128_000,
        native.used?.kind === 'report'
          ? Math.min(native.used.windowTokens, native.used.autoCompactAtTokens ?? Infinity)
          : Infinity
      )
      const nativeOccupancy =
        native.used?.kind === 'report'
          ? native.used.usedTokens
          : native.used?.kind === 'estimate'
            ? contextTokensFromUsage(native.used.usage)
            : 0
      const id = randomUUID()
      const select = async (deliveryId: string) => {
        let limit = encoding?.limit ?? 8 * 1024 * 1024
        for (;;) {
          const selected = selectRecoveryDelivery({
            id: deliveryId,
            capture: handoff.capture,
            body,
            modelWindow,
            nativeOccupancy,
            ...(encoding ? { encodedInputBytes: encoding.bytes, encodedLimit: limit } : {}),
            ...(transcriptPath ? { transcriptPath } : {})
          })
          const actual = await ctx.adapter.historicalInputBytes?.({
            sessionId: ctx.sessionId,
            body: withRecoveryContext(body, selected.encodedContext)
          })
          if (!actual || actual.bytes <= actual.limit) {
            return selected
          }
          if (selected.itemIds.length === 0) {
            throw new RecoveryContextBudgetError('Saved context cannot fit beside this input')
          }
          limit -= actual.bytes - actual.limit + 32
        }
      }
      const selection = await select(id)
      const make = (
        mode: ContextTransferDelivery['mode'],
        deliveryId = id
      ): ContextTransferDelivery => ({
        kind: 'delivery',
        id: deliveryId,
        sessionId: ctx.sessionId,
        handoffId: handoff.id,
        targetId: target.id,
        mode,
        carrierInputId: mode === 'inline' ? clientMessageId : null,
        preparedAt: ctx.now(),
        selection,
        outcome: null
      })
      if (head.handle.transport === 'codex-app-server' && ctx.adapter.injectHistoricalContext) {
        const injection = { ...make('inject'), writeStartedAt: ctx.now() }
        await write(injection, true)
        let outcome: Awaited<ReturnType<NonNullable<typeof ctx.adapter.injectHistoricalContext>>>
        try {
          outcome = await ctx.adapter.injectHistoricalContext({
            sessionId: ctx.sessionId,
            fence: ctx.fence,
            deliveryId: id,
            targetId: target.id,
            context: selection.encodedContext,
            coverageText: selection.coverageText,
            messages: handoff.capture.messages.filter((message) =>
              selection.itemIds.includes(message.itemId)
            ),
            signal
          })
        } catch (error) {
          await write({
            ...injection,
            outcome: {
              kind: 'unknown',
              at: ctx.now(),
              reason: 'The native history write has no proved acknowledgement'
            }
          })
          throw error
        }
        await write({
          ...injection,
          outcome:
            outcome.kind === 'injected'
              ? { kind: 'injected', at: ctx.now(), requestId: outcome.requestId }
              : { kind: 'unsupported', at: ctx.now() }
        })
        if (outcome.kind === 'injected') {
          return body
        }
        // The definitive no-write method rejection alone permits an inline attempt.
        const inlineId = randomUUID()
        const inlineSelection = await select(inlineId)
        await write({ ...make('inline', inlineId), selection: inlineSelection }, true)
        return withRecoveryContext(body, inlineSelection.encodedContext)
      }
      await write(make('inline'), true)
      return withRecoveryContext(body, selection.encodedContext)
    }
  }
}
