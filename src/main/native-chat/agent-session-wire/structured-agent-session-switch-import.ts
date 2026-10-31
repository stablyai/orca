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
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { AgentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { prepareLegacyTranscriptImport } from '../agent-session-journal/journal-legacy-import'
import type { JournalReplacementItem } from '../agent-session-journal/journal-epoch-replacement'
import {
  lastUserItem,
  planSwitchTranscriptAdditions,
  switchLifecycleRecord,
  switchTranscriptMutations,
  type PreparedSwitchRead
} from './structured-agent-session-switch-import-plan'
import { isUnexplainedInterruptedTurn } from './structured-agent-session-synthetic-turn'
import { codexRestingPromptKey } from './structured-agent-session-codex-turns'

export type SwitchTranscriptSource = {
  agent: AgentType
  sessionId: string
  filePath: string
  codexHome?: string | null
  source?: AdoptedTranscriptSource
}

type AdoptedTranscriptRead =
  | { ok: true; items: JournalReplacementItem[] | null }
  | { ok: false; refusal: AgentSessionWireRefusal }

export type SwitchStoppedCliTurn = Pick<
  SwitchTranscriptSource,
  'agent' | 'sessionId' | 'filePath'
> & {
  userItemKey: string
  turnId: string
  /** The history read before the stop: a first adoption's if the file can't be read after it. */
  baseline: PreparedSwitchRead
}

const transcriptUnreadable = () =>
  agentSessionRefusalError('agent_session_identity_required', { reason: 'transcriptUnreadable' })

async function prepare(
  source: SwitchTranscriptSource,
  deadline: AgentSessionSwitchDeadline,
  piAfterEntry?: string
): Promise<PreparedSwitchRead> {
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
    throw transcriptUnreadable()
  }
  return prepared
}

/** Pi entries through the chat's claim are already its history; its own work since can't merge. */
function piHistoryCut(
  journal: AgentSessionJournal,
  source: Pick<SwitchTranscriptSource, 'agent' | 'filePath'>,
  resumeCursor: string | undefined
): { entry?: string; mergeable: boolean } {
  if (source.agent !== 'pi') {
    return { mergeable: true }
  }
  const view = readPiHistoryJournalView(journal, new Set([source.filePath]))
  const claim = usablePiHistoryClaim(decodePiHistoryClaim(resumeCursor), view)
  return { entry: claim?.entry, mergeable: view.ownWorkSequence <= (claim?.sequence ?? 0) }
}

/**
 * This capture is used only with an explicit Stop and positive exit of its exact CLI. `retained`:
 * the chat that already holds the conversation, whose own history the read starts after.
 */
export async function captureSwitchStoppedCliTurn(
  source: SwitchTranscriptSource,
  working: boolean,
  deadline: AgentSessionSwitchDeadline,
  retained?: { journal: AgentSessionJournal; resumeCursor?: string }
): Promise<SwitchStoppedCliTurn | undefined> {
  if (!working) {
    return undefined
  }
  const piAfterEntry =
    retained && piHistoryCut(retained.journal, source, retained.resumeCursor).entry
  const prepared = await prepare(source, deadline, piAfterEntry)
  const user = lastUserItem(prepared.items)
  if (!user || (prepared.latestTurn && prepared.latestTurn.state !== 'working')) {
    return undefined
  }
  const key = agentJournalItemKey(user.identity)
  return {
    agent: source.agent,
    sessionId: source.sessionId,
    filePath: source.filePath,
    userItemKey: key,
    turnId: prepared.latestTurn?.turnId ?? key,
    baseline: prepared
  }
}

/** The turn a switch stopped with proof of exit, as the turn record every later import keeps. */
function stoppedTurnRecord(stopped: SwitchStoppedCliTurn, userItemId: string) {
  return switchLifecycleRecord(stopped, stopped.turnId, {
    kind: 'turn',
    turnId: stopped.turnId,
    userItemId,
    state: 'interrupted',
    outcome: 'cancellation'
  })
}

/**
 * A first adoption after a proven stop founds the chat on its fresh read, or on what the switch read
 * before the stop when the file can't be read now, and saves the stopped turn with that history.
 */
export function withSwitchStoppedTurn(
  read: AdoptedTranscriptRead,
  stopped: SwitchStoppedCliTurn
): AdoptedTranscriptRead {
  const items = read.ok ? read.items : [...stopped.baseline.items]
  if (!items?.some((item) => agentJournalItemKey(item.identity) === stopped.userItemKey)) {
    return read
  }
  return { ok: true, items: [...items, stoppedTurnRecord(stopped, stopped.userItemKey)] }
}

/**
 * Record a proven stop on the chat that already holds the conversation, before any later read can
 * fail, in the same write as the history ahead of it: what the import adds from the read before the
 * stop. Codex's rows have one writer, the resting import; its record names its prompt as that
 * import does, so the rows it lands later join this turn wherever the record sits.
 */
export async function commitSwitchStoppedCliTurn(input: {
  journal: AgentSessionJournal
  stopped: SwitchStoppedCliTurn
  fence: number
  resumeCursor?: string
}): Promise<void> {
  const { journal, stopped } = input
  if (!piHistoryCut(journal, stopped, input.resumeCursor).mergeable) {
    throw transcriptUnreadable()
  }
  const prompt =
    stopped.agent === 'codex'
      ? codexRestingPromptKey(journal, stopped.sessionId, stopped.userItemKey)
      : stopped.userItemKey
  const additions =
    stopped.agent === 'codex'
      ? [stoppedTurnRecord(stopped, prompt)]
      : planSwitchTranscriptAdditions({
          journal,
          source: stopped,
          prepared: stopped.baseline,
          stopped,
          check: () => {}
        })
  const record = agentJournalItemKey(switchLifecycleRecord(stopped, stopped.turnId).identity)
  await journal.appendPlannedLifecycleBatch({
    settlementId: `switch-stop:${stopped.sessionId}:${stopped.turnId}`,
    fence: input.fence,
    plan: () => ({
      dispatches: [],
      // An interruption saved without its verdict keeps its record and takes this one.
      mutations: switchTranscriptMutations(journal, additions, (item, current) =>
        agentJournalItemKey(item.identity) === record && isUnexplainedInterruptedTurn(current)
          ? { ...item, body: { ...current, outcome: 'cancellation', userItemId: prompt } }
          : item
      )
    })
  })
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
  const cut = piHistoryCut(input.journal, input.source, input.resumeCursor)
  if (!cut.mergeable) {
    throw transcriptUnreadable()
  }
  const prepared = await prepare(input.source, input.deadline, cut.entry)
  const additions = planSwitchTranscriptAdditions({
    ...input,
    prepared,
    check: input.check ?? input.deadline.check
  })
  const digest = createHash('sha256').update(JSON.stringify(additions)).digest('hex')
  await input.journal.appendPlannedLifecycleBatch({
    settlementId: `switch-import:${digest}`,
    fence: input.fence,
    plan: () => {
      input.deadline.check()
      input.check?.()
      return { dispatches: [], mutations: switchTranscriptMutations(input.journal, additions) }
    }
  })
}
