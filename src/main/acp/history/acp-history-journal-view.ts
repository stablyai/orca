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
import type {
  JournalAcpHistory,
  JournalAcpHistoryRow,
  JournalAcpTurnCursor
} from '../../native-chat/agent-session-journal/journal-domain-acp-history'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { StructuredAgentSessionHistoryJournal } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-journal-views'
import {
  continuedOutsideRecordId,
  captureHistoryCatchUpView
} from '../../native-chat/agent-session-wire/acquisition/structured-agent-session-history-catch-up'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AcpHistoryScope } from './acp-history-translation'
import {
  acpAdoptedRecordIds,
  type AcpHistoryCandidate,
  type AcpHistoryReadJournal
} from './acp-history-turn-matching'
import { acpHistoryHasOutput } from './acp-history-turn-content'

/** Keys named per keyed read; the reader also ends a page at its byte budget. */
const SAVED_ITEMS_KEYS = 1_024

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
function admission(
  scope: AcpHistoryScope,
  journal: Pick<JournalAcpHistory, 'turns'>,
  dividers: Set<string>
) {
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

/** Saved rows by key plus the turn rows and openers they name, each read once. */
async function savedItems(
  history: StructuredAgentSessionHistoryJournal,
  keys: readonly string[]
): Promise<SavedItems> {
  const items = new Map<string, AgentJournalRenderItem>()
  const canonical = new Map<string, string>()
  let pending = [...new Set(keys)]
  while (pending.length > 0) {
    const next = new Set<string>()
    for (let offset = 0; offset < pending.length;) {
      const page = await history.reads.acpHistoryItems(
        pending.slice(offset, offset + SAVED_ITEMS_KEYS)
      )
      for (const item of page.items) {
        items.set(item.itemId, item)
        next.add(item.turnScope?.kind === 'turn' ? item.turnScope.turnItemId : '')
        next.add(readAgentJournalTurn(item.body)?.userItemId ?? '')
      }
      for (const [key, canonicalItemId] of page.canonical) {
        canonical.set(key, canonicalItemId)
      }
      offset += page.consumed
    }
    pending = [...next].filter((key) => key !== '' && !canonical.has(key))
  }
  return { items, canonical }
}

type SavedItems = {
  items: ReadonlyMap<string, AgentJournalRenderItem>
  canonical: ReadonlyMap<string, string>
}

function itemReader(saved: SavedItems, admits: (item: AgentJournalRenderItem) => boolean) {
  return (key: string) => {
    const item = saved.items.get(key)
    return item && admits(item) ? item : null
  }
}

/** Every page of turn facts; each page stays far below the reader reply limit. */
async function turnFacts(history: StructuredAgentSessionHistoryJournal, scope: AcpHistoryScope) {
  const turns: JournalAcpHistory['turns'] = []
  const natives: JournalAcpHistory['natives'] = []
  let adopted = false
  let after: JournalAcpTurnCursor | null = null
  do {
    const page: JournalAcpHistory = await history.reads.acpHistory({
      agent: scope.agent,
      sessionId: scope.sessionId,
      providerSessionId: scope.providerSessionId,
      after
    })
    turns.push(...page.turns)
    natives.push(...page.natives)
    adopted ||= page.adopted
    after = page.next
  } while (after)
  return {
    turns,
    natives: natives.toSorted((a, b) => a.sequence - b.sequence || a.ordinal - b.ordinal),
    adopted
  }
}

async function savedRows(
  history: StructuredAgentSessionHistoryJournal,
  keys: readonly string[]
): Promise<JournalAcpHistoryRow[]> {
  const rows: JournalAcpHistoryRow[] = []
  for (let offset = 0; offset < keys.length; offset += SAVED_ITEMS_KEYS) {
    rows.push(
      ...(await history.reads.acpHistoryRows(keys.slice(offset, offset + SAVED_ITEMS_KEYS)))
    )
  }
  return rows
}

/** Coverage reads paged turn facts, keyed placements and saved turn rows; replies scale with the replay. */
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
    const adoptedKeys = new Map(
      candidates.flatMap(({ source }) =>
        acpAdoptedRecordIds(source.messageIds).map(
          (recordId) =>
            [
              agentJournalItemKey({
                provider: 'legacy',
                agent: scope.agent,
                sessionId: scope.providerSessionId,
                recordId
              }),
              recordId
            ] as const
        )
      )
    )
    const [accepted, facts, rows, turns, rawOrigin] = await Promise.all([
      history.reads.input({ kind: 'accepted-submissions' }),
      turnFacts(history, scope),
      savedRows(history, [...new Set([...outputKeys, ...adoptedKeys.keys()])]),
      savedItems(history, turnKeys),
      history.reads.historyOrigin()
    ])
    const dividers = new Set(
      candidates.map(({ source }) => acpHistoryDividerKey(scope, source.turn))
    )
    const { placed, admits } = admission(scope, facts, dividers)
    const placements = new Map(
      rows.flatMap((row) =>
        placed(row.itemId, row.turnItemId) ? [[row.itemId, row] as const] : []
      )
    )
    const saved: AcpHistoryReadJournal = {
      natives: facts.natives,
      adoptedAny: facts.adopted,
      adopted: new Map(
        rows.flatMap((row) => {
          const recordId = adoptedKeys.get(row.itemId)
          return recordId === undefined ? [] : [[recordId, row.sequence] as const]
        })
      ),
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
  const { saved, physicalCursor } = await captureHistoryCatchUpView(history, async () => ({
    saved: await savedItems(history, keys)
  }))
  if (
    physicalCursor.epoch !== baseline.physicalCursor.epoch ||
    physicalCursor.sequence !== baseline.physicalCursor.sequence
  ) {
    throw new Error('stale-history')
  }
  return {
    read: itemReader(saved, baseline.admits),
    canonical: saved.canonical
  }
}
