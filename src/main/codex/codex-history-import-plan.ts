import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import {
  codexItemIdentity,
  CodexTurnOrdinals,
  readCodexThreadItem
} from './codex-structured-item-translation'
import { createHash } from 'node:crypto'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import {
  journalLifecycleItemMutation,
  type JournalLifecycleMutationInput
} from '../native-chat/agent-session-journal/journal-row-builders'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionItemAppendOptions
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import {
  CODEX_RESTORE_MAX_BYTES,
  CODEX_RESTORE_MAX_OPERATIONS
} from './codex-structured-journal-translation-restore'

/** Invocation-local shared translation: nothing reaches the live sink until this plan is whole. */
export function createCodexHistoryImportPlan(input: {
  sessionId: string
  threadId: string
  journal: StructuredAgentSessionTransitionJournal
  nativePromptKeys: ReadonlySet<string>
  outsideNotice?: AgentJournalItemBody
  check: () => void
}) {
  const mutations: JournalLifecycleMutationInput[] = []
  const encoded = new Map<string, string>()
  const turnIds: string[] = []
  let bytes = 0
  let outsideNoted = false
  let omitted = new Map<string, string>()
  const append = (
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: StructuredAgentSessionItemAppendOptions
  ) => {
    input.check()
    const key = agentJournalItemKey(identity)
    if (omitted.has(key)) {
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
    bytes += Buffer.byteLength(serialized, 'utf8') + 1
    if (mutations.length >= CODEX_RESTORE_MAX_OPERATIONS || bytes > CODEX_RESTORE_MAX_BYTES) {
      throw new Error('too-large')
    }
    mutations.push(mutation)
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
  const translator = createCodexJournalTranslator({
    sink,
    sessionId: input.sessionId,
    primaryThreadId: () => input.threadId,
    historyImport: true
  })
  return {
    append,
    restore: (turn: Record<string, unknown>) => {
      input.check()
      if (typeof turn.id !== 'string') {
        throw new Error('invalid-turn')
      }
      omitted = new Map<string, string>()
      const ordinals = new CodexTurnOrdinals()
      let native = false
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
        if (item.type === 'userMessage') {
          if (
            typeof item.clientId === 'string' &&
            item.clientId.length > 0 &&
            input.nativePromptKeys.has(agentJournalSubmissionKey(item.clientId))
          ) {
            native = true
            omitted.set(agentJournalItemKey(identity), agentJournalSubmissionKey(item.clientId))
          } else {
            outsideUser = true
          }
        }
      }
      if ((!native || outsideUser) && !outsideNoted && input.outsideNotice) {
        append(
          {
            provider: 'legacy',
            agent: 'codex',
            sessionId: input.sessionId,
            recordId: `continued-outside:${turn.id}`
          },
          input.outsideNotice,
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        outsideNoted = true
      }
      const restored = translator.restoreThread(input.threadId, { turns: [turn] })
      if (!restored.accepted) {
        throw new Error(restored.reason)
      }
      turnIds.push(turn.id)
    },
    finish: () => {
      input.check()
      const keys = [...encoded.keys()]
      const digest = createHash('sha256')
        .update(JSON.stringify([input.journal.epoch, input.threadId, turnIds, keys]))
        .digest('hex')
      const settlementId = `codex-history-import:${digest}`
      // Match the existing batch envelope charge, plus the transition's one publication byte.
      const reservedBytes =
        Buffer.byteLength(JSON.stringify({ settlementId, mutations }), 'utf8') + 512
      if (reservedBytes + 1 > CODEX_RESTORE_MAX_BYTES) {
        throw new Error('too-large')
      }
      return { settlementId, mutations, keys, turnIds, reservedBytes }
    },
    dispose: () => translator.dispose()
  }
}
