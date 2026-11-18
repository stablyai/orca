import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  nativeCopyCoverage,
  journalImportTime
} from '../../native-chat/agent-session-journal/context-epochs/journal-history-origin'
import type { JournalAcpHistory } from '../../native-chat/agent-session-journal/journal-domain-acp-history'
import type { JournalHistoryItem } from '../../native-chat/agent-session-journal/journal-history-items'
import type { StructuredAgentSessionHistoryJournal } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-journal-views'
import {
  continuedOutsideRecordId,
  captureHistoryCatchUpView
} from '../../native-chat/agent-session-wire/acquisition/structured-agent-session-history-catch-up'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AcpHistoryScope } from './acp-history-translation'
import type { AcpHistoryCandidate, AcpHistoryReadJournal } from './acp-history-turn-matching'
import { acpHistoryHasOutput } from './acp-history-turn-content'

/** Keys per keyed read, so one page of saved bodies stays far below the read's own bound. */
const SAVED_ITEMS_PAGE = 64

const KINDS: ReadonlySet<AgentJournalItemBody['kind']> = new Set([
  'message',
  'tool-call',
  'diff',
  'approval',
  'question',
  'status',
  'turn'
])

export function acpHistoryDividerKey(scope: AcpHistoryScope, turn: string): string {
  return agentJournalItemKey({
    provider: 'legacy',
    agent: scope.agent,
    sessionId: scope.sessionId,
    recordId: continuedOutsideRecordId(turn)
  })
}

/** Which saved rows coverage and ownership may consult: this session's turns, theirs, and adopted rows. */
function admission(scope: AcpHistoryScope, journal: JournalAcpHistory, dividers: Set<string>) {
  const turnKeys = new Set(journal.turns.map((turn) => turn.itemId))
  const userKeys = new Set(journal.turns.flatMap((turn) => turn.userItemId ?? []))
  const placed = (itemId: string, turnItemId: string | null) => {
    const id = parseAgentJournalItemKey(itemId)
    return (
      turnKeys.has(itemId) ||
      userKeys.has(itemId) ||
      (turnItemId !== null && turnKeys.has(turnItemId)) ||
      (id?.provider === 'legacy' &&
        id.agent === scope.agent &&
        id.sessionId === scope.providerSessionId)
    )
  }
  const admits = (item: AgentJournalRenderItem) =>
    KINDS.has(item.body.kind) &&
    ((dividers.has(item.itemId) &&
      item.turnScope?.kind === 'thread' &&
      item.body.kind === 'status' &&
      (item.body.presentation === 'continued-outside' ||
        item.body.presentation === 'continued-outside-rewound' ||
        item.body.presentation === 'history-loaded')) ||
      placed(item.itemId, item.turnScope?.kind === 'turn' ? item.turnScope.turnItemId : null))
  return { placed, admits }
}

async function savedItems(
  history: StructuredAgentSessionHistoryJournal,
  keys: readonly string[]
): Promise<JournalHistoryItem[]> {
  const entries: JournalHistoryItem[] = []
  for (let offset = 0; offset < keys.length; offset += SAVED_ITEMS_PAGE) {
    entries.push(
      ...(await history.reads.historyItems(keys.slice(offset, offset + SAVED_ITEMS_PAGE)))
    )
  }
  return entries
}

function itemReader(
  entries: readonly JournalHistoryItem[],
  admits: (item: AgentJournalRenderItem) => boolean
) {
  const items = new Map(
    entries.flatMap((entry) =>
      entry.item && admits(entry.item) ? [[entry.item.itemId, entry.item] as const] : []
    )
  )
  return (key: string) => items.get(key) ?? null
}

/** Coverage reads turn facts, placements and saved turn rows; no saved output reaches main. */
export async function readAcpHistoryJournal(
  scope: AcpHistoryScope,
  history: StructuredAgentSessionHistoryJournal,
  candidates: readonly AcpHistoryCandidate[]
) {
  return captureHistoryCatchUpView(history, async () => {
    const sourceItems = candidates.flatMap(({ items }) => items)
    // Matching reads whole saved turn rows, but only the placement of rows with output.
    const turnKeys = sourceItems.flatMap((item) =>
      item.body.kind === 'turn' ? [agentJournalItemKey(item.identity)] : []
    )
    const outputKeys = sourceItems.flatMap((item) =>
      acpHistoryHasOutput(item.body) ? [agentJournalItemKey(item.identity)] : []
    )
    const [accepted, journal, turns, rawOrigin] = await Promise.all([
      history.reads.input({ kind: 'accepted-submissions' }),
      history.reads.acpHistory({
        agent: scope.agent,
        sessionId: scope.sessionId,
        providerSessionId: scope.providerSessionId,
        itemIds: outputKeys
      }),
      savedItems(history, turnKeys),
      history.reads.historyOrigin()
    ])
    const dividers = new Set(
      candidates.map(({ source }) => acpHistoryDividerKey(scope, source.turn))
    )
    const { placed, admits } = admission(scope, journal, dividers)
    const placements = new Map(
      journal.held.flatMap((held) =>
        placed(held.itemId, held.turnItemId) ? [[held.itemId, held] as const] : []
      )
    )
    const saved: AcpHistoryReadJournal = {
      natives: journal.natives,
      adopted: new Map(journal.adopted),
      item: itemReader(turns, admits),
      placement: (key) => placements.get(key) ?? null
    }
    // Aliases are rejected; their target bodies cannot establish exact provider coverage.
    const requests = new Set(
      accepted.submissions
        .filter((send) => send.handedOverAt !== undefined || send.handoverRecorded !== true)
        .map((send) => `prompt:${send.clientMessageId}`)
    )
    const handle = { kind: 'opaque' as const, agent: scope.agent, value: scope.providerSessionId }
    const importedAt = journalImportTime(rawOrigin, handle)
    const covered = nativeCopyCoverage(rawOrigin, scope.agent, 'acp-user-message', handle)
    return { journal: saved, admits, requests, importedAt, covered }
  })
}

/** Saved bodies of only the rows a plan may write, read at the coverage view's own position. */
export async function readAcpHistoryBodies(
  history: StructuredAgentSessionHistoryJournal,
  baseline: {
    physicalCursor: AgentJournalCursor
    admits: (item: AgentJournalRenderItem) => boolean
  },
  keys: readonly string[]
) {
  if (keys.length === 0) {
    return { read: () => null, canonical: new Map<string, string>() }
  }
  const { entries, physicalCursor } = await captureHistoryCatchUpView(history, async () => ({
    entries: await savedItems(history, keys)
  }))
  if (
    physicalCursor.epoch !== baseline.physicalCursor.epoch ||
    physicalCursor.sequence !== baseline.physicalCursor.sequence
  ) {
    throw new Error('stale-history')
  }
  return {
    read: itemReader(entries, baseline.admits),
    canonical: new Map(entries.map((entry) => [entry.key, entry.canonicalItemId]))
  }
}
