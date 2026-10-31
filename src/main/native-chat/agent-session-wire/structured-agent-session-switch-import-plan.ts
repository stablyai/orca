import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalReplacementItem } from '../agent-session-journal/journal-epoch-replacement'
import type { PreparedLegacyImport } from '../agent-session-journal/journal-legacy-import-contract'
import { switchTranscriptNativeCoverage } from './structured-agent-session-switch-import-coverage'
import type {
  SwitchStoppedCliTurn,
  SwitchTranscriptSource
} from './structured-agent-session-switch-import'
import {
  isSyntheticInterruptedTurn,
  isUnexplainedInterruptedTurn,
  revisedTurnRecord
} from './structured-agent-session-synthetic-turn'

export type PreparedSwitchRead = Extract<PreparedLegacyImport, { ok: true }>

/**
 * The anchor of a read's latest turn record: its first user row where the read marks turns (a
 * steer stays under it), else the last user row. A turn that opened in view whose prompt fell
 * outside the read names its own record, never another turn's prompt.
 */
export function latestTurnUserKey(
  { items, latestTurnOpener, latestTurn }: PreparedSwitchRead,
  source: Pick<SwitchTranscriptSource, 'agent' | 'sessionId'>
): string | undefined {
  if (latestTurnOpener === null) {
    return (
      latestTurn && agentJournalItemKey(switchLifecycleRecord(source, latestTurn.turnId).identity)
    )
  }
  const user =
    latestTurnOpener !== undefined
      ? items.find((item) => agentJournalItemKey(item.identity) === latestTurnOpener)
      : items.findLast((item) => item.body.kind === 'message' && item.body.role === 'user')
  return user && agentJournalItemKey(user.identity)
}

/** The rows a read holds that this chat doesn't, in transcript order, then the turn records. */
export function planSwitchTranscriptAdditions(input: {
  journal: AgentSessionJournal
  source: Pick<SwitchTranscriptSource, 'agent' | 'sessionId'>
  prepared: PreparedSwitchRead
  stopped?: SwitchStoppedCliTurn
  settleAbandoned?: boolean
  check: () => void
}): JournalReplacementItem[] {
  const { prepared } = input
  const items = prepared.items
  const userKey = latestTurnUserKey(prepared, input.source)
  const latest = prepared.latestTurn
  const interrupted =
    input.stopped?.sessionId === input.source.sessionId &&
    input.stopped.userItemKey === userKey &&
    (!latest ||
      (latest.turnId === input.stopped.turnId &&
        (latest.state === 'working' ||
          (latest.state === 'interrupted' && latest.outcome === undefined))))
  const covered = switchTranscriptNativeCoverage({
    agent: input.source.agent,
    providerSessionId: input.source.sessionId,
    journal: input.journal,
    items,
    check: input.check
  })
  const additions =
    input.source.agent === 'codex'
      ? []
      : items.filter((item) => !covered.has(agentJournalItemKey(item.identity)))
  const ended =
    latest && latest.state !== 'working' ? { ...latest, state: latest.state } : undefined
  // No writer is left and the turn never ended: it is over. Unknown evidence (no lifecycle, or a
  // reply only a legacy format calls complete) gets no label rather than a guessed one.
  const abandoned =
    !interrupted &&
    input.settleAbandoned === true &&
    latest?.state === 'working' &&
    !prepared.latestTurnAmbiguous
  const turnId = interrupted ? input.stopped?.turnId : abandoned ? latest?.turnId : ended?.turnId
  // Codex's turn records have one writer, the resting importer, which anchors them to saved rows.
  if (input.source.agent !== 'codex' && turnId && userKey && !covered.has(userKey)) {
    additions.push(
      switchLifecycleRecord(input.source, turnId, {
        kind: 'turn',
        turnId,
        userItemId: userKey,
        state: interrupted || abandoned ? 'interrupted' : ended!.state,
        ...(interrupted
          ? { outcome: 'cancellation' as const }
          : ended?.outcome
            ? { outcome: ended.outcome }
            : {}),
        ...(ended?.timestamp == null ? {} : { completedAt: ended.timestamp })
      })
    )
  }
  // An earlier turn Orca settled whose real boundary has since been recorded takes that boundary,
  // and an interruption saved without its verdict takes the one its stop record carries.
  if (input.source.agent !== 'codex') {
    const added = new Set(additions.map((item) => agentJournalItemKey(item.identity)))
    // Grok's latest turn comes from its sidecar, not the transcript rows.
    const states = new Map(prepared.turnStates)
    if (latest) {
      states.set(latest.turnId, latest)
    }
    for (const [id, state] of states) {
      const key = agentJournalItemKey(switchLifecycleRecord(input.source, id).identity)
      const body = input.journal.item(input.journal.canonicalItemId(key))?.body
      const revisit =
        isSyntheticInterruptedTurn(body) ||
        (isUnexplainedInterruptedTurn(body) && state.outcome !== undefined)
      if (state.state !== 'working' && revisit && !added.has(key)) {
        const outcome = state.outcome ?? (state.state === 'interrupted' ? body.outcome : undefined)
        additions.push(
          switchLifecycleRecord(input.source, id, {
            kind: 'turn',
            turnId: id,
            ...(body.userItemId ? { userItemId: body.userItemId } : {}),
            state: state.state,
            ...(outcome ? { outcome } : {}),
            ...(state.timestamp == null ? {} : { completedAt: state.timestamp })
          })
        )
      }
    }
  }
  return additions
}

/**
 * Each addition the chat lacks, or what a saved turn record takes from it (`revisedTurnRecord`):
 * every direct batch of turn records goes through here, so none erases or moves an opener.
 */
export function switchTranscriptMutations(
  journal: AgentSessionJournal,
  additions: readonly JournalReplacementItem[],
  revise?: (item: JournalReplacementItem, current?: AgentJournalItemBody) => JournalReplacementItem
) {
  const savedRow = (key: string) => {
    const id = journal.canonicalItemId(key)
    return journal.item(id) ? id : undefined
  }
  return additions.flatMap((addition) => {
    const current = journal.item(journal.canonicalItemId(agentJournalItemKey(addition.identity)))
    const item = revise?.(addition, current?.body) ?? addition
    const body = current ? revisedTurnRecord(current, item.body, savedRow) : item.body
    return body
      ? [
          {
            kind: 'item' as const,
            ...item,
            body,
            turnScope: item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
          }
        ]
      : []
  })
}

export function switchLifecycleRecord(
  source: Pick<SwitchTranscriptSource, 'agent' | 'sessionId'>,
  turnId: string,
  body?: Extract<AgentJournalItemBody, { kind: 'turn' }>
): JournalReplacementItem {
  return {
    identity: {
      provider: 'legacy',
      agent: source.agent,
      sessionId: source.sessionId,
      recordId: `turn-lifecycle:${turnId}`
    },
    ownerFence: 0,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE,
    body: body ?? { kind: 'turn', turnId, state: 'running' }
  }
}
