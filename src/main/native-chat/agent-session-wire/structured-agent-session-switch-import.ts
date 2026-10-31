import { switchTranscriptNativeCoverage } from './structured-agent-session-switch-import-coverage'
import {
  decodePiHistoryClaim,
  readPiHistoryJournalView,
  usablePiHistoryClaim
} from '../../pi/rpc-history-journal-view'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { AgentType } from '../../../shared/agent-status-types'
import { getSystemCodexHomePath } from '../../codex/codex-home-paths'
import type { AdoptedTranscriptSource } from '../agent-session-journal/adopted-transcript-source'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../shared/agent-session-journal-types'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { prepareLegacyTranscriptImport } from '../agent-session-journal/journal-legacy-import'
import type { JournalReplacementItem } from '../agent-session-journal/journal-epoch-replacement'
import {
  isSyntheticInterruptedTurn,
  turnRecordReplaceable
} from './structured-agent-session-synthetic-turn'

export type SwitchTranscriptSource = {
  agent: AgentType
  sessionId: string
  filePath: string
  codexHome?: string | null
  source?: AdoptedTranscriptSource
}

export type SwitchStoppedCliTurn = {
  sessionId: string
  userItemKey: string
  turnId: string
}

async function prepare(
  source: SwitchTranscriptSource,
  deadline: AgentSessionSwitchDeadline,
  piAfterEntry?: string
) {
  deadline.check()
  const prepared = await prepareLegacyTranscriptImport({
    agent: source.agent,
    piAfterEntry,
    sessionId: source.sessionId,
    options: {
      filePath: source.filePath,
      source: source.source,
      ...(source.agent === 'codex' && source.codexHome !== undefined
        ? { codexSessionsDirs: [join(source.codexHome ?? getSystemCodexHomePath(), 'sessions')] }
        : {})
    }
  })
  deadline.check()
  if (!prepared.ok) {
    throw agentSessionRefusalError('agent_session_identity_required', {
      reason: 'transcriptUnreadable'
    })
  }
  return prepared
}

function lastUser(items: readonly JournalReplacementItem[]) {
  return items.findLast((item) => item.body.kind === 'message' && item.body.role === 'user')
}

/** This capture is used only with an explicit Stop and positive exit of its exact CLI. */
export async function captureSwitchStoppedCliTurn(
  source: SwitchTranscriptSource,
  working: boolean,
  deadline: AgentSessionSwitchDeadline
): Promise<SwitchStoppedCliTurn | undefined> {
  if (!working) {
    return undefined
  }
  const prepared = await prepare(source, deadline)
  const user = lastUser(prepared.items)
  if (!user || (prepared.latestTurn && prepared.latestTurn.state !== 'working')) {
    return undefined
  }
  const key = agentJournalItemKey(user.identity)
  return {
    sessionId: source.sessionId,
    userItemKey: key,
    turnId: prepared.latestTurn?.turnId ?? key
  }
}

/** Append through the existing journal owner: native submissions and imported identities survive. */
export async function catchUpSwitchedCliTranscript(input: {
  journal: AgentSessionJournal
  source: SwitchTranscriptSource
  fence: number
  deadline: AgentSessionSwitchDeadline
  stopped?: SwitchStoppedCliTurn
  /** The CLI writer census passed and the structured owner is at rest: an open turn is over. */
  settleAbandoned?: boolean
  check?: () => void
  resumeCursor?: string
}) {
  let piAfterEntry: string | undefined
  if (input.source.agent === 'pi') {
    const view = readPiHistoryJournalView(input.journal, new Set([input.source.filePath]))
    const claim = usablePiHistoryClaim(decodePiHistoryClaim(input.resumeCursor), view)
    if (view.ownWorkSequence > (claim?.sequence ?? 0)) {
      throw agentSessionRefusalError('agent_session_identity_required', {
        reason: 'transcriptUnreadable'
      })
    }
    piAfterEntry = claim?.entry
  }
  const prepared = await prepare(input.source, input.deadline, piAfterEntry)
  const items = prepared.items
  const user = lastUser(items)
  const userKey = user && agentJournalItemKey(user.identity)
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
    check: input.check ?? input.deadline.check
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
      lifecycleRecord(input.source, turnId, {
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
  // An earlier turn Orca settled whose real boundary has since been recorded takes that boundary.
  if (input.source.agent !== 'codex') {
    // Grok's latest turn comes from its sidecar, not the transcript rows.
    const states = new Map(prepared.turnStates)
    if (latest) {
      states.set(latest.turnId, latest)
    }
    for (const [id, state] of states) {
      const body = input.journal.item(
        input.journal.canonicalItemId(
          agentJournalItemKey(lifecycleRecord(input.source, id).identity)
        )
      )?.body
      if (id !== turnId && state.state !== 'working' && isSyntheticInterruptedTurn(body)) {
        const outcome = state.outcome ?? (state.state === 'interrupted' ? body.outcome : undefined)
        additions.push(
          lifecycleRecord(input.source, id, {
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
  const digest = createHash('sha256').update(JSON.stringify(additions)).digest('hex')
  await input.journal.appendPlannedLifecycleBatch({
    settlementId: `switch-import:${digest}`,
    fence: input.fence,
    plan: () => {
      input.deadline.check()
      input.check?.()
      return {
        dispatches: [],
        mutations: additions
          .filter((item) => {
            const current = input.journal.item(
              input.journal.canonicalItemId(agentJournalItemKey(item.identity))
            )
            return !current || turnRecordReplaceable(current.body, item.body)
          })
          .map((item) => ({
            kind: 'item' as const,
            ...item,
            turnScope: item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
          }))
      }
    }
  })
}

function lifecycleRecord(
  source: SwitchTranscriptSource,
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
