import type { CodexSubagentExecutions } from './codex-subagent-executions'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import {
  codexItemIdentity,
  CodexTurnOrdinals,
  readCodexThreadItem
} from './codex-structured-item-translation'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { journalLifecycleItemMutation } from '../native-chat/agent-session-journal/journal-row-builders'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionItemAppendOptions
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'
import {
  continuedOutsideRecordId,
  createHistoryCatchUpBatch
} from '../native-chat/agent-session-wire/structured-agent-session-history-catch-up'
import { createCodexHistoryTranslator } from './codex-structured-journal-translation'
import { codexTurnLifecycleIdentity } from './codex-structured-journal-translation-turns'

/** Invocation-local shared translation: nothing reaches the live sink until this plan is whole. */
export function createCodexHistoryImportPlan(input: {
  sessionId: string
  threadId: string
  journal: StructuredAgentSessionTransitionJournal
  subagentExecutions?: CodexSubagentExecutions
  nativePromptKeys: ReadonlySet<string>
  outsideNotice?: AgentJournalItemBody
  check: () => void
}) {
  const batch = createHistoryCatchUpBatch()
  const encoded = new Map<string, string>()
  const turnIds: string[] = []
  let outsideNoted = false
  let outsideTurn: string | null = null
  let omitted = new Map<string, string>()
  let existingIdentities = new Map<string, AgentJournalItemIdentity>()
  const append = (
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: StructuredAgentSessionItemAppendOptions
  ) => {
    input.check()
    identity = existingIdentities.get(agentJournalItemKey(identity)) ?? identity
    const key = agentJournalItemKey(identity)
    if (omitted.has(key) || input.journal.presentationRemoved(key)) {
      return { accepted: true } as const
    }
    // The saved relation is display-only: name the original prompt without accepting its send.
    if (body.kind === 'turn' && body.userItemId) {
      const nativePrompt = omitted.get(body.userItemId)
      if (nativePrompt !== undefined) {
        body = { ...body, userItemId: nativePrompt }
      }
    }
    const mutation = {
      ...journalLifecycleItemMutation(options, identity, body),
      ...(body.kind === 'message' && body.role === 'user' ? { echoOf: null } : {})
    }
    const serialized = JSON.stringify(mutation)
    const previous = encoded.get(key)
    if (previous !== undefined) {
      if (previous !== serialized) {
        throw new Error('conflicting-history-identity')
      }
      return { accepted: true } as const
    }
    const existing = input.journal.item(input.journal.canonicalItemId(key))
    if (
      existing &&
      ((body.kind === 'message' && body.role === 'user') ||
        (existing.body.kind === 'turn' &&
          existing.body.state !== 'running' &&
          existing.body.state !== 'unverifiable') ||
        JSON.stringify(existing.body) === JSON.stringify(body))
    ) {
      return { accepted: true } as const
    }
    if (outsideTurn && !outsideNoted && input.outsideNotice) {
      const turnId = outsideTurn
      outsideNoted = true
      append(
        {
          provider: 'legacy',
          agent: 'codex',
          sessionId: input.sessionId,
          recordId: continuedOutsideRecordId(turnId)
        },
        input.outsideNotice,
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    }
    if (existing && mutation.kind === 'item') {
      batch.revise(mutation, { canonicalItemId: existing.itemId, revision: existing.revision })
    } else {
      batch.push(mutation, serialized)
    }
    encoded.set(key, serialized)
    return { accepted: true } as const
  }
  const sink: StructuredAgentSessionEventSink = {
    appendItem: append,
    tryAppendItem: append,
    appendTombstone: () => {
      throw new Error('unexpected-history-tombstone')
    },
    publish: () => {},
    tryPublish: () => ({ accepted: true }),
    tryReviseResolvedItem: (_reserved, resolve, options) => {
      const item = resolve(input.journal)
      return item ? append(item.identity, item.body, options) : { accepted: true }
    }
  }
  const translator = createCodexHistoryTranslator({
    sink,
    sessionId: input.sessionId,
    primaryThreadId: () => input.threadId,
    historyImport: true,
    subagentExecutions: input.subagentExecutions
  })
  return {
    append,
    restore: (turn: Record<string, unknown>) => {
      input.check()
      if (typeof turn.id !== 'string') {
        throw new Error('invalid-turn')
      }
      if (
        input.journal.presentationRemoved(
          agentJournalItemKey(codexTurnLifecycleIdentity(input.sessionId, turn.id))
        )
      ) {
        return
      }
      omitted = new Map<string, string>()
      existingIdentities = new Map<string, AgentJournalItemIdentity>()
      const ordinals = new CodexTurnOrdinals()
      let native = false
      let hidden = false
      let outsideUser = false
      for (const value of Array.isArray(turn.items) ? turn.items : []) {
        const item = readCodexThreadItem(value)
        if (!item) {
          continue
        }
        const identity = codexItemIdentity({
          threadId: input.threadId,
          turnId: typeof turn.id === 'string' ? turn.id : null,
          item,
          ordinals,
          historyImport: true
        })
        const key = agentJournalItemKey(identity)
        const canonical = input.journal.canonicalItemId(key)
        if (input.nativePromptKeys.has(canonical)) {
          native = true
          hidden ||= input.journal.presentationRemoved(canonical)
          omitted.set(key, canonical)
        }
        const liveIdentity: AgentJournalItemIdentity = {
          provider: 'orca',
          clientMessageId: `codex-item:${input.threadId}:${item.id}`
        }
        const liveKey = agentJournalItemKey(liveIdentity)
        if (identity.provider === 'orca' && input.journal.item(liveKey)) {
          existingIdentities.set(key, liveIdentity)
        }
        if (item.type === 'userMessage') {
          if (
            typeof item.clientId === 'string' &&
            item.clientId.length > 0 &&
            input.nativePromptKeys.has(agentJournalSubmissionKey(item.clientId))
          ) {
            native = true
            hidden ||= input.journal.presentationRemoved(agentJournalSubmissionKey(item.clientId))
            omitted.set(agentJournalItemKey(identity), agentJournalSubmissionKey(item.clientId))
          } else if (!input.nativePromptKeys.has(canonical)) {
            outsideUser = true
          }
        }
      }
      if (hidden) {
        return
      }
      outsideTurn = !native || outsideUser ? turn.id : null
      const restored = translator.restoreThread(input.threadId, { turns: [turn] })
      if (!restored.accepted) {
        throw new Error(restored.reason)
      }
      turnIds.push(turn.id)
    },
    finish: () => {
      input.check()
      const keys = [...encoded.keys()]
      if (batch.size === 0) {
        return null
      }
      const plan = batch.finish('codex-history-import', [
        input.journal.epoch,
        input.threadId,
        turnIds,
        keys
      ])
      return { ...plan, turnIds }
    },
    dispose: () => translator.dispose()
  }
}
