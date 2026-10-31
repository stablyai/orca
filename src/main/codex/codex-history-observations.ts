import { resolveHistoryDependencies } from './codex-history-dependencies'
import { codexHistoryAddresses } from './codex-history-addresses'
import { savedTurnFacts, retainedSize } from './codex-history-workspace'
import { constrainSavedHistoryItem } from './codex-history-saved-constraints'
import { historySourceItem } from './codex-history-item-values'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'
import {
  codexNonMessageIdentity,
  isCodexMessageItemType,
  readCodexThreadItem,
  type CodexThreadItem
} from './codex-thread-item-identity'
import { codexTurnLifecycleIdentity } from './codex-structured-journal-translation-turns'
import type {
  HistoryAnchor,
  CodexHistoryObservation,
  CodexHistoryObservedTurn
} from './codex-history-source-facts'
import {
  compatibleHistoryStatus,
  compatibleHistoryInvocation,
  historyInvocationFields,
  historyItemFinality,
  reconcileHistoryItem,
  terminalHistoryStatus
} from './codex-history-source-facts'
import { CODEX_RESTORE_MAX_BYTES } from './codex-structured-journal-translation-restore'
import { readCodexJournalRecord } from './codex-structured-journal-translation-values'

export function createCodexHistoryObservations(input: {
  sessionId: string
  threadId: string
  journal: StructuredAgentSessionTransitionJournal
  nativePromptKeys: ReadonlySet<string>
  check: () => void
  retainedHelperBytes: () => number
}) {
  let group: CodexHistoryObservedTurn | null = null
  let bytes = 0
  const charge = (delta: number) => {
    bytes += delta
    if (bytes + input.retainedHelperBytes() > CODEX_RESTORE_MAX_BYTES) {
      throw new Error('history-workspace-too-large')
    }
  }
  const row = (key: string) => input.journal.item(input.journal.canonicalItemId(key))
  const { address, savedParent } = codexHistoryAddresses(input)
  return {
    get group() {
      return group
    },
    get bytes() {
      return bytes
    },
    release() {
      group = null
      bytes = 0
    },
    restore(turn: Record<string, unknown>) {
      input.check()
      const turnId = turn.id
      if (typeof turnId !== 'string' || !turnId) {
        throw new Error('invalid-turn')
      }
      if (turn.threadId !== undefined && turn.threadId !== input.threadId) {
        throw new Error('invalid-thread')
      }
      const turnKey = agentJournalItemKey(codexTurnLifecycleIdentity(input.sessionId, turnId))
      if (!group) {
        group = {
          id: turnId,
          source: { id: turnId },
          items: new Map(),
          saved: row(turnKey),
          key: input.journal.canonicalItemId(turnKey),
          hidden: input.journal.presentationRemoved(turnKey)
        }
        charge(retainedSize({ id: turnId, key: group.key }, null))
      }
      const target = group
      if (target.hidden) {
        return
      }
      const next = Object.fromEntries(
        ['id', 'status', 'startedAt', 'completedAt', 'durationMs']
          .filter((key) => turn[key] != null)
          .map((key) => [key, turn[key]])
      )
      const constraints = { ...target.source, ...savedTurnFacts(target.saved) }
      const validTurn =
        compatibleHistoryStatus(constraints.status, next.status) &&
        !(constraints.completedAt != null && next.status === 'inProgress') &&
        !(
          constraints.startedAt != null &&
          next.startedAt != null &&
          constraints.startedAt !== next.startedAt
        )
      if (validTurn) {
        const merged = { ...target.source, ...next }
        if (terminalHistoryStatus(target.source.status)) {
          merged.status = target.source.status
        }
        for (const key of ['startedAt', 'completedAt', 'durationMs']) {
          if (target.source[key] != null) {
            merged[key] = target.source[key]
          }
        }
        charge(retainedSize(merged, null) - retainedSize(target.source, null))
        target.source = merged
      }
      // The index belongs to this source only: raw IDs can overlap different slots on resume.
      const source = new Map<string, { key: string; raw: unknown }>()
      const entries: { key: string; raw: unknown; identity: AgentJournalItemIdentity }[] = []
      let ordinal = 0,
        sourceBytes = 0
      for (const raw of Array.isArray(turn.items) ? turn.items : []) {
        input.check()
        const record = readCodexJournalRecord(raw)
        const message = typeof record.type === 'string' && isCodexMessageItemType(record.type)
        const slot = ordinal
        if (message) {
          ordinal++
        }
        if (typeof record.id !== 'string' || typeof record.type !== 'string') {
          continue
        }
        const identity: AgentJournalItemIdentity = message
          ? { provider: 'codex', threadId: input.threadId, turnId, ordinal: slot }
          : codexNonMessageIdentity(input.threadId, turnId, record.id, true)
        const key = agentJournalItemKey(identity)
        const metadata =
          retainedSize(
            [
              record.id,
              key,
              identity,
              key,
              record.id,
              record.parentCallId,
              record.parentToolCallId
            ],
            null
          ) + 64
        sourceBytes += metadata
        charge(metadata)
        source.set(record.id, { key, raw })
        entries.push({ key, raw, identity })
      }
      const refusedInvocations = new Set<string>()
      const parents = new Map<string, string | null>()
      const prior = new Map<string, CodexHistoryObservation | undefined>()
      for (const { key: sourceKey, raw, identity } of entries) {
        input.check()
        const parsed = readCodexThreadItem(raw)
        if (!parsed) {
          continue
        }
        const observed = historySourceItem(parsed)
        if (!observed) {
          refusedInvocations.add(parsed.id)
          continue
        }
        const resolved = address(identity, observed, target)
        const previous = resolved ? target.items.get(resolved.key) : undefined
        const chosen = previous
          ? {
              identity: previous.identity,
              key: agentJournalItemKey(previous.identity),
              saved: previous.saved,
              aliases: previous.anchors.filter(
                (anchor) => anchor.key !== agentJournalItemKey(previous.identity)
              )
            }
          : resolved
        if (
          !chosen ||
          (observed.threadId !== undefined && observed.threadId !== input.threadId) ||
          (observed.turnId !== undefined && observed.turnId !== turnId)
        ) {
          refusedInvocations.add(parsed.id)
          continue
        }
        const key = chosen.key
        const sourceEntry = source.get(parsed.id)
        if (sourceEntry) {
          sourceEntry.key = key
        }
        const canonical = input.journal.canonicalItemId(sourceKey)
        const native =
          previous?.native ??
          (input.nativePromptKeys.has(canonical)
            ? canonical
            : observed.type === 'userMessage' &&
                typeof observed.clientId === 'string' &&
                input.nativePromptKeys.has(agentJournalSubmissionKey(observed.clientId))
              ? agentJournalSubmissionKey(observed.clientId)
              : undefined)
        if (native && input.journal.presentationRemoved(native)) {
          target.hidden = true
          target.items.clear()
          break
        }
        if (input.journal.presentationRemoved(chosen.key)) {
          refusedInvocations.add(parsed.id)
          continue
        }
        if (!validTurn && chosen.saved && !previous && !historyItemFinality(observed)) {
          continue
        }
        const constrained = native ? observed : constrainSavedHistoryItem(chosen.saved, observed)
        const anchorOnly: CodexThreadItem = {
          ...historyInvocationFields(observed),
          type: observed.type,
          id: observed.id
        }
        const invocationValid =
          (!previous || compatibleHistoryInvocation(previous.item, observed)) &&
          (native || constrainSavedHistoryItem(chosen.saved, anchorOnly) !== null)
        if (!invocationValid) {
          refusedInvocations.add(parsed.id)
          continue
        }
        refusedInvocations.delete(parsed.id)
        const accepted =
          constrained &&
          reconcileHistoryItem(
            previous,
            constrained,
            validTurn && terminalHistoryStatus(next.status)
          )
        if (!accepted) {
          continue
        }
        const parent = accepted.item.parentCallId ?? accepted.item.parentToolCallId
        parents.set(key, typeof parent === 'string' ? parent : null)
        const anchors: HistoryAnchor[] = chosen.saved
          ? [{ key: chosen.key, saved: chosen.saved }, ...chosen.aliases]
          : []
        const observation: CodexHistoryObservation = {
          ...accepted,
          identity: chosen.identity,
          saved: chosen.saved,
          ...(native ? { native } : {}),
          anchors,
          bytes: 0
        }
        observation.bytes = retainedSize(
          {
            item: observation.item,
            identity: observation.identity,
            native,
            parent,
            anchors: anchors.map((anchor) => [
              anchor.key,
              anchor.saved.itemId,
              anchor.saved.revision
            ])
          },
          chosen.saved
        )
        const rollback = typeof parent === 'string' ? previous : undefined
        charge(observation.bytes - (prior.has(key) || !rollback ? (previous?.bytes ?? 0) : 0))
        if (!prior.has(key) && rollback) {
          prior.set(key, rollback)
        }
        target.items.set(key, observation)
      }
      resolveHistoryDependencies({
        target,
        parents,
        prior,
        source,
        refusedInvocations,
        charge,
        savedParent: (id) => savedParent(id, target)
      })
      for (const [key, old] of prior) {
        if (old && target.items.get(key) !== old) {
          charge(-old.bytes)
        }
      }
      charge(-sourceBytes)
    }
  }
}
