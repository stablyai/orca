import {
  nativeCopyIds,
  usableJournalHistoryOrigin
} from '../../../native-chat/agent-session-journal/context-epochs/journal-history-origin'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalPosition } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentJournalItemPosition,
  compareAgentJournalPositions
} from '../../../../shared/agent-session/journal/agent-session-journal-position'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { isRootAgentJournalItem } from '../../../../shared/agent-session/journal/agent-session-journal-producer'
import type { StructuredAgentSessionHistoryJournal } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-journal-views'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  captureHistoryCatchUpView,
  type HistoryCatchUpJournalView
} from '../../../native-chat/agent-session-wire/acquisition/structured-agent-session-history-catch-up'

const TURN_LIFECYCLE_RECORD_PREFIX = 'turn-lifecycle:'

export type CodexHistoryJournalView = {
  epoch: string
  nativePromptKeys: ReadonlySet<string>
  physicalCursor?: AgentJournalCursor
  unresolvedIds?: ReadonlySet<string>
  /** Provider turns represented by saved rows or native receipts. */
  known: ReadonlySet<string>
  terminal?: ReadonlySet<string>
  assistants?: ReadonlySet<string>
  /** Latest represented turn by journal position, including within a batch. */
  latest: string | null
  latestPosition: AgentJournalPosition | null
  hasRows: boolean
  /** Proven transcript origin, independent of subsequently imported provider identities. */
  importedAt: number | null
  covered?: ReadonlySet<string>
  origin?: unknown
  unresolvedOrigin: boolean
}

export async function readCodexHistoryJournalView(
  journal: StructuredAgentSessionHistoryJournal,
  threadId: string,
  _signal: AbortSignal
): Promise<CodexHistoryJournalView & HistoryCatchUpJournalView> {
  return captureHistoryCatchUpView(journal, async (physicalCursor) => {
    const known = new Set<string>()
    const nativePromptKeys = new Set<string>()
    const lifecycles = new Set<string>()
    const assistants = new Set<string>()
    let latest: string | null = null
    let latestPosition: AgentJournalPosition | null = null
    const positions = new Map<string, AgentJournalPosition>()
    let hasLegacy = false
    const note = (turnId: string, position: AgentJournalPosition): void => {
      known.add(turnId)
      if (latestPosition === null || compareAgentJournalPositions(position, latestPosition) > 0) {
        latest = turnId
        latestPosition = position
      }
    }
    const [hasRows, rawOrigin, inputs] = await Promise.all([
      journal.reads.hasItems(),
      journal.reads.historyOrigin(),
      journal.reads.input({
        kind: 'batch',
        reads: [
          { kind: 'accepted-submissions' },
          { kind: 'unsettled-submissions' },
          { kind: 'capture-keys', present: [] }
        ]
      }),
      journal.reads.visitItems(
        { kinds: ['message', 'tool-call', 'diff', 'approval', 'question', 'status', 'turn'] },
        (itemId, _sequence, body, attribution, item) => {
          const identity = parseAgentJournalItemKey(itemId)
          if (identity?.provider === 'orca' && body.kind === 'message') {
            positions.set(itemId, agentJournalItemPosition(item))
          }
          if (!isRootAgentJournalItem(attribution)) {
            return
          }
          if (
            identity?.provider === 'legacy' &&
            identity.agent === 'codex' &&
            identity.sessionId === threadId &&
            (body.kind === 'message' || body.kind === 'tool-call')
          ) {
            hasLegacy = true
          }
          if (identity?.provider === 'orca' && body.kind === 'message' && body.role === 'user') {
            nativePromptKeys.add(itemId)
          }
          const turnId = codexTurnIdOfRow(itemId, body, threadId)
          if (turnId) {
            if (body.kind === 'message' && body.role === 'assistant') {
              assistants.add(turnId)
            }
            const turn = readAgentJournalTurn(body)
            if (turn && turn.state !== 'running' && turn.state !== 'unverifiable') {
              lifecycles.add(turnId)
            }
            note(turnId, agentJournalItemPosition(item))
          }
        }
      )
    ])
    const [accepted, unsettled, captured] = inputs.results
    if (
      accepted?.kind !== 'accepted-submissions' ||
      unsettled?.kind !== 'unsettled-submissions' ||
      captured?.kind !== 'capture-keys'
    ) {
      throw new Error('invalid-history-inputs')
    }
    // Accepted submissions can identify turns whose rows have not landed yet.
    for (const submission of accepted.submissions) {
      const promptKey = agentJournalSubmissionKey(submission.clientMessageId)
      nativePromptKeys.add(promptKey)
      const identity = submission.providerItemId
        ? parseAgentJournalItemKey(submission.providerItemId)
        : null
      if (identity?.provider === 'codex' && identity.threadId === threadId) {
        const prompt = positions.get(promptKey)
        if (prompt) {
          note(identity.turnId, prompt)
        }
      }
    }
    const origin = usableJournalHistoryOrigin(rawOrigin)
    const importedAt =
      origin?.kind === 'legacy_import' &&
      origin.providerHandle.kind === 'codex' &&
      origin.providerHandle.threadId === threadId
        ? origin.importedAt
        : null
    const copy =
      origin?.kind === 'native_copy' &&
      origin.unit === 'codex-turn' &&
      origin.agent === 'codex' &&
      origin.providerHandle.kind === 'codex' &&
      origin.providerHandle.threadId === threadId
        ? origin
        : null
    return {
      ...(copy ? { covered: nativeCopyIds(copy) } : {}),
      origin: rawOrigin,
      epoch: physicalCursor.epoch,
      nativePromptKeys: new Set([...nativePromptKeys, ...captured.keys]),
      unresolvedIds: new Set(unsettled.submissions.map((send) => send.clientMessageId)),
      known,
      terminal: lifecycles,
      assistants,
      latest,
      latestPosition,
      hasRows,
      importedAt,
      unresolvedOrigin: (hasLegacy || rawOrigin !== null) && importedAt === null && !copy
    }
  })
}

function codexTurnIdOfRow(
  itemId: string,
  body: Parameters<typeof readAgentJournalTurn>[0],
  threadId: string
): string | null {
  const identity = parseAgentJournalItemKey(itemId)
  if (identity?.provider === 'codex') {
    return identity.threadId === threadId ? identity.turnId : null
  }
  const turn = readAgentJournalTurn(body)
  if (!turn) {
    return null
  }
  // Command rows use Orca turn IDs; their provider turn ID is stored separately.
  if (body?.kind === 'turn' && body.providerTurnId) {
    return body.providerTurnId
  }
  return identity?.provider === 'legacy' &&
    identity.agent === 'codex' &&
    identity.recordId.startsWith(TURN_LIFECYCLE_RECORD_PREFIX)
    ? turn.turnId
    : null
}

/** Planning and commit use the same authoritative saved facts. */
export function sameCodexHistoryJournalView(
  a: CodexHistoryJournalView,
  b: CodexHistoryJournalView
): boolean {
  return (
    a.epoch === b.epoch &&
    a.physicalCursor?.epoch === b.physicalCursor?.epoch &&
    a.physicalCursor?.sequence === b.physicalCursor?.sequence &&
    JSON.stringify([...(a.unresolvedIds ?? [])]) === JSON.stringify([...(b.unresolvedIds ?? [])]) &&
    a.unresolvedOrigin === b.unresolvedOrigin &&
    a.importedAt === b.importedAt &&
    a.hasRows === b.hasRows &&
    a.latest === b.latest &&
    JSON.stringify(a.latestPosition) === JSON.stringify(b.latestPosition) &&
    JSON.stringify([...(a.terminal ?? [])]) === JSON.stringify([...(b.terminal ?? [])]) &&
    JSON.stringify([...(a.assistants ?? [])]) === JSON.stringify([...(b.assistants ?? [])]) &&
    a.known.size === b.known.size &&
    [...a.known].every((id) => b.known.has(id)) &&
    sameNativePromptKeys(a.nativePromptKeys, b.nativePromptKeys)
  )
}

function sameNativePromptKeys(
  a: CodexHistoryJournalView['nativePromptKeys'],
  b: CodexHistoryJournalView['nativePromptKeys']
): boolean {
  return a.size === b.size && [...a].every((key) => b.has(key))
}
