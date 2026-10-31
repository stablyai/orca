import { preserveSavedHistoryPayload } from './codex-history-projection'
import { isDeepStrictEqual } from 'node:util'
import { CodexSubagentExecutions } from './codex-subagent-executions'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalRenderItem,
  AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { journalLifecycleItemMutation } from '../native-chat/agent-session-journal/journal-row-builders'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'
import {
  continuedOutsideRecordId,
  createHistoryCatchUpBatch
} from '../native-chat/agent-session-wire/structured-agent-session-history-catch-up'
import { createCodexHistoryObservations } from './codex-history-observations'
import type { HistoryAnchor } from './codex-history-source-facts'
import { codexJournalItem } from './codex-structured-item-translation'
import {
  CODEX_RESTORE_MAX_BYTES,
  historicalTurnLifecycle
} from './codex-structured-journal-translation-restore'
import {
  codexTurnLifecycleBody,
  codexTurnLifecycleIdentity,
  reviseCodexTurnRow
} from './codex-structured-journal-translation-turns'
import { codexCompactionKey } from './codex-structured-journal-compactions'
import { readCodexSubagentAnnouncements } from './codex-subagent-activity'
import {
  endedJournalReasoning,
  withJournalReasoningLifecycle
} from '../native-chat/agent-session-journal/journal-reasoning-row'

/** Reconcile each completed source group before unique projection into one checked transaction. */
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
  const helpers = new CodexSubagentExecutions()
  const helperIds = new Map<string, string | null>()
  const turnIds: string[] = []
  const expected = new Set<string>()
  let helperBytes = 0,
    outsideNoted = false
  const observations = createCodexHistoryObservations({
    ...input,
    retainedHelperBytes: () => helperBytes
  })
  const completeTurn = () => {
    input.check()
    const turn = observations.group
    if (!turn || turn.hidden) {
      observations.release()
      return
    }
    const identity = codexTurnLifecycleIdentity(input.sessionId, turn.id)
    const scope: AgentJournalTurnScope = { kind: 'turn', turnItemId: turn.key }
    const lifecycle = historicalTurnLifecycle(input.threadId, turn.source)
    if (!lifecycle) {
      observations.release()
      return
    }
    const dependencies = new Map<string, HistoryAnchor>()
    const writes = new Set<string>()
    const require = (anchor: HistoryAnchor) =>
      dependencies.set(
        JSON.stringify([anchor.key, anchor.saved.itemId, anchor.saved.revision]),
        anchor
      )
    let changed = false
    let compacted = false
    const outside =
      ![...turn.items.values()].some(({ native }) => native) ||
      [...turn.items.values()].some(({ item, native }) => item.type === 'userMessage' && !native)
    const append = (
      identity: AgentJournalItemIdentity,
      body: AgentJournalItemBody,
      scope: AgentJournalTurnScope,
      saved: AgentJournalRenderItem | null
    ): boolean => {
      const key = agentJournalItemKey(identity)
      if (
        input.journal.presentationRemoved(key) ||
        (saved &&
          ((body.kind === 'message' && body.role === 'user') ||
            isDeepStrictEqual(saved.body, body)))
      ) {
        return false
      }
      if (!outsideNoted && input.outsideNotice && outside) {
        outsideNoted = true
        const notice: AgentJournalItemIdentity = {
          provider: 'legacy',
          agent: 'codex',
          sessionId: input.sessionId,
          recordId: continuedOutsideRecordId(turn.id)
        }
        const savedNotice = input.journal.item(agentJournalItemKey(notice))
        append(notice, input.outsideNotice, AGENT_JOURNAL_THREAD_SCOPE, savedNotice)
      }
      input.check()
      const mutation = journalLifecycleItemMutation(
        { turnScope: saved?.turnScope ?? scope },
        identity,
        body
      )
      if (body.kind === 'message' && body.role === 'user') {
        mutation.echoOf = null
      }
      if (saved) {
        batch.revise(mutation, { canonicalItemId: saved.itemId, revision: saved.revision })
        expected.add(JSON.stringify([key, saved.itemId, saved.revision]))
      } else {
        batch.push(mutation)
      }
      writes.add(key)
      changed = true
      return true
    }
    for (const { item, anchors } of turn.items.values()) {
      for (const announcement of readCodexSubagentAnnouncements(item, input.threadId)) {
        input.check()
        const old = helpers.label(announcement.agentThreadId)
        helpers.register(announcement.agentThreadId, announcement.label)
        const label = helpers.label(announcement.agentThreadId)
        helperBytes +=
          Buffer.byteLength(label ?? '') -
          Buffer.byteLength(old ?? '') +
          (helperIds.has(announcement.agentThreadId)
            ? 0
            : Buffer.byteLength(announcement.agentThreadId) + 32)
        if (helperBytes + observations.bytes > CODEX_RESTORE_MAX_BYTES) {
          throw new Error('history-workspace-too-large')
        }
        helperIds.set(announcement.agentThreadId, label)
        for (const anchor of anchors) {
          require(anchor)
        }
        if (turn.saved) {
          require({ key: agentJournalItemKey(identity), saved: turn.saved })
        }
      }
    }
    const prompt = [...turn.items.values()].find(({ item }) => item.type === 'userMessage')
    if (prompt) {
      lifecycle.userItemId =
        prompt.native ?? input.journal.canonicalItemId(agentJournalItemKey(prompt.identity))
    } else {
      delete lifecycle.userItemId
    }
    const body = codexTurnLifecycleBody(lifecycle)
    const savedTurn = turn.saved?.body
    if (savedTurn?.kind === 'turn') {
      for (const key of [
        'startedAt',
        'requestedAt',
        'completedAt',
        'durationMs',
        'outcome',
        'userItemId'
      ] as const) {
        if (savedTurn[key] !== undefined) {
          Object.assign(body, { [key]: savedTurn[key] })
        }
      }
      if (savedTurn.state === 'interrupted') {
        body.state = savedTurn.state
      }
    }
    const lifecycleChanged = append(
      identity,
      reviseCodexTurnRow(input.journal, identity, body),
      AGENT_JOURNAL_THREAD_SCOPE,
      turn.saved
    )
    if (lifecycleChanged && body.userItemId) {
      const savedUser = input.journal.item(body.userItemId)
      if (savedUser) {
        require({ key: body.userItemId, saved: savedUser })
      }
    }
    for (const observation of turn.items.values()) {
      input.check()
      if (observation.native) {
        continue
      }
      const item = observation.item
      let translated: AgentJournalItemBody | null
      let chosenIdentity = observation.identity,
        saved = observation.saved
      if (item.type === 'contextCompaction') {
        if (compacted) {
          continue
        }
        compacted = true
        chosenIdentity = {
          provider: 'orca',
          clientMessageId: `codex-compaction:${codexCompactionKey(input.threadId, turn.id)}`
        }
        saved = input.journal.item(agentJournalItemKey(chosenIdentity))
        translated = { kind: 'status', text: 'Context compacted', presentation: 'compaction' }
      } else if (item.type === 'subAgentActivity') {
        continue
      } else {
        translated = codexJournalItem(
          item,
          (id) => helpers.label(id) ?? input.subagentExecutions?.label(id) ?? null
        ).body
      }
      if (!translated) {
        continue
      }
      translated = preserveSavedHistoryPayload(item, translated, saved)
      if (
        append(
          chosenIdentity,
          withJournalReasoningLifecycle(translated, endedJournalReasoning()),
          scope,
          saved
        )
      ) {
        if (turn.saved) {
          require({ key: agentJournalItemKey(identity), saved: turn.saved })
        }
        for (const anchor of observation.anchors) {
          require(anchor)
        }
        if (observation.parent) {
          const parent = turn.items.get(observation.parent)
          if (parent?.saved) {
            require({ key: agentJournalItemKey(parent.identity), saved: parent.saved })
          }
        }
      }
    }
    for (const [checked, anchor] of dependencies) {
      if (!writes.has(anchor.key) && !expected.has(checked)) {
        batch.expectItem(anchor.key, {
          canonicalItemId: anchor.saved.itemId,
          revision: anchor.saved.revision
        })
        expected.add(checked)
      }
    }
    if (changed) {
      turnIds.push(turn.id)
    }
    observations.release()
  }
  return {
    restore: observations.restore,
    completeTurn,
    finish: () => {
      completeTurn()
      if (!batch.size && !helperIds.size) {
        return null
      }
      return {
        ...batch.finish('codex-history-import', [input.journal.epoch, input.threadId, turnIds]),
        turnIds
      }
    },
    discardHelpers: () => helperIds.clear(),
    restoreHelpers: () => {
      for (const [id, label] of helperIds) {
        input.subagentExecutions?.register(id, label)
      }
      helperIds.clear()
    },
    dispose: () => {
      observations.release()
      helpers.clear()
      expected.clear()
    }
  }
}
