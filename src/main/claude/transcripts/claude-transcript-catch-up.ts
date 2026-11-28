import {
  nativeCopyIds,
  usableJournalHistoryOrigin,
  type JournalHistoryOrigin
} from '../../native-chat/agent-session-journal/context-epochs/journal-history-origin'
import { recoverClaudeTranscript } from './claude-transcript-recovery'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAgentSessionHistoryJournal } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-journal-views'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import type { StructuredAgentSessionEventSink } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import {
  captureHistoryCatchUpView,
  runHistoryCatchUp
} from '../../native-chat/agent-session-wire/acquisition/structured-agent-session-history-catch-up'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { resolveSessionFilePath } from '../../native-chat/session-file-resolver'
import { createClaudeTranscriptImportPlan } from './claude-transcript-import-plan'
import { readClaudeTranscriptTail } from './claude-transcript-tail'
import { isClaudeTranscriptRootPrompt } from './claude-transcript-root-prompt'
import {
  claudeTranscriptItemKeys,
  createClaudeTranscriptItemReader
} from './claude-transcript-item-reader'

const DEFAULT_CLAUDE_CATCH_UP_TIMEOUT_MS = 30_000
/** What an import too big to land throws: retrying it unchanged lands nothing either. */
const OVER_CAPS = new Set(['too-large', 'history-workspace-too-large'])
/** Per chat with no saved turn end, for this app run: null when it isn't on its first turn (it never
 *  imports), else the transcript state its first turn was last imported or found over the caps at. */
const settledFirstTurns = new Map<string, { filePath: string; key: string } | null>()

/** What would change a first-turn import's outcome: the transcript's size and write time. */
async function transcriptKey(filePath: string): Promise<string | undefined> {
  const info = await stat(filePath).catch(() => null)
  return info ? `${info.size}:${info.mtimeMs}` : undefined
}

/** Settled this run and unchanged since: an open reads neither the journal nor the transcript. */
async function firstTurnSettled(sessionId: string): Promise<boolean> {
  const settled = settledFirstTurns.get(sessionId)
  return settled === null || (!!settled && (await transcriptKey(settled.filePath)) === settled.key)
}

type ClaudeHistoryView = {
  physicalCursor: AgentJournalCursor
  origin: JournalHistoryOrigin | null
  covered?: ReadonlySet<string>
  hasRows: boolean
  newest: { key: string; sequence: number; index: number } | null
  /** Root turns the chat holds. */
  turns: number
}

// Rows after the saved turn-end leaf come from an external resume or interrupted local turn; skip items already held.

/** Display only and optional: it never settles a send and never gates opening. */
export async function catchUpClaudeTranscript(input: {
  sessionId: string
  providerSessionId: string
  leafUuid: string
  /** No turn end was saved (the first turn never finished in Orca): import after the first prompt. */
  fromFirstPrompt?: boolean
  claudeConfigDir: string
  cwd: string
  sink: StructuredAgentSessionEventSink
  signal?: AbortSignal
  assertCurrent?: () => void
  timeoutMs?: number
  logger?: StructuredAgentSessionLogger
}): Promise<boolean> {
  if (input.leafUuid === '' && input.fromFirstPrompt && (await firstTurnSettled(input.sessionId))) {
    return false
  }
  let complete = false
  let settle: (() => void) | undefined
  const outcome = await runHistoryCatchUp({
    agentName: 'Claude',
    scope: 'claude-transcript-catch-up',
    sessionId: input.sessionId,
    sink: input.sink,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.assertCurrent ? { assertCurrent: input.assertCurrent } : {}),
    timeoutMs: input.timeoutMs ?? DEFAULT_CLAUDE_CATCH_UP_TIMEOUT_MS,
    ...(input.logger ? { logger: input.logger } : {}),
    readView: (history): Promise<ClaudeHistoryView> =>
      captureHistoryCatchUpView(history, async () => {
        const hasRows = await history.reads.hasItems()
        let newest: { key: string; sequence: number; index: number } | null = null
        let turns = 0
        await history.reads.visitItems(
          { kinds: ['turn'] },
          (key, sequence, _body, linkage, item) => {
            if (!isRootAgentJournalItem(linkage)) {
              return
            }
            turns += 1
            const index = item.sequenceIndex ?? 0
            if (
              !newest ||
              sequence > newest.sequence ||
              (sequence === newest.sequence && index > newest.index)
            ) {
              newest = { key, sequence, index }
            }
          }
        )
        const origin = await history.reads.historyOrigin()
        const copy = usableJournalHistoryOrigin(origin)
        const covered =
          copy?.kind === 'native_copy' &&
          copy.unit === 'claude-entry' &&
          copy.agent === 'claude' &&
          copy.providerHandle.kind === 'claude' &&
          copy.providerHandle.sessionId === input.providerSessionId
            ? nativeCopyIds(copy)
            : undefined
        return { hasRows, newest, origin, covered, turns }
      }),
    // An import over the caps leaves nothing behind; settled, so an unchanged chat doesn't retry it.
    prepare: (context) =>
      prepare(context).catch((error: unknown) => {
        if (error instanceof Error && OVER_CAPS.has(error.message)) {
          settle?.()
        }
        throw error
      })
  })
  const caughtUp = complete && (outcome === 'committed' || outcome === 'checked')
  if (caughtUp) {
    settle?.()
  }
  return caughtUp

  async function prepare({
    view,
    history,
    signal,
    check,
    yieldTurn,
    warn
  }: Parameters<Parameters<typeof runHistoryCatchUp<ClaudeHistoryView>>[0]['prepare']>[0]) {
    // Decided from the journal first, so a chat with nothing to import touches no files.
    const planned = await view()
    check()
    // Only a chat on its first turn: an older one without a saved leaf is left as it is.
    const afterFirstPrompt =
      input.leafUuid === '' && !planned.covered && !!input.fromFirstPrompt && planned.turns === 1
    if (input.leafUuid === '' && !planned.covered && !afterFirstPrompt) {
      if (input.fromFirstPrompt && planned.turns > 1) {
        settledFirstTurns.set(input.sessionId, null)
      }
      return null
    }
    const claudeProjectsDir = join(input.claudeConfigDir, 'projects')
    // A moved project can leave its transcript outside the cwd's bucket; the resolver probes both.
    const filePath = await resolveSessionFilePath(
      'claude',
      input.providerSessionId,
      { claudeProjectsDir, cwd: input.cwd },
      signal
    )
    check()
    if (!filePath) {
      return null
    }
    // Taken before any read, so a write landing during the import makes the next open retry.
    const key = afterFirstPrompt ? await transcriptKey(filePath) : undefined
    const settleHere = () => {
      if (key !== undefined) {
        settledFirstTurns.set(input.sessionId, { filePath, key })
      }
    }
    settle = settleHere
    // A first turn imported before reads on from its newest row, so a later open repeats nothing.
    const leaf = afterFirstPrompt
      ? ((await newestClaudeRow(history.reads, input.providerSessionId)) ?? '')
      : input.leafUuid
    check()
    let leafAbsent = leaf === '' && (!!planned.covered || afterFirstPrompt)
    const tail = leafAbsent
      ? null
      : await readClaudeTranscriptTail({
          filePath,
          leafUuid: leaf,
          ...claudeTranscriptLeaf(leaf),
          check,
          onLeafAbsent: () => {
            leafAbsent = true
          }
        })
    check()
    if (!tail && !(leafAbsent && (planned.covered || afterFirstPrompt))) {
      // Past the tail's read budget: as over the caps as a too-large import.
      settleHere()
      warn('leaf-not-in-tail')
      return null
    }
    const items = await createClaudeTranscriptItemReader(
      history.reads,
      input.sessionId,
      (tail?.rows ?? []).flatMap((row) => {
        const attachment = row.attachment
        const source =
          attachment && typeof attachment === 'object' && 'source_uuid' in attachment
            ? attachment.source_uuid
            : undefined
        return [row.uuid, source].filter((uuid): uuid is string => typeof uuid === 'string')
      }),
      (tail?.rows ?? []).flatMap((row) => claudeTranscriptItemKeys(row, input.providerSessionId))
    )
    const staging = createClaudeTranscriptImportPlan({
      sessionId: input.sessionId,
      providerSessionId: input.providerSessionId,
      epoch: history.cursor().epoch,
      items,
      rewound: planned.hasRows ? (tail?.rewound ?? !afterFirstPrompt) : null,
      check
    })
    try {
      // A tail starts after the first prompt; a whole-chain scan finds it first.
      let prompted = !afterFirstPrompt || tail !== null
      const restore = async (row: Record<string, unknown>) => {
        check()
        if (!prompted) {
          // The chat already shows its first prompt; the active chain after it is what's missing.
          prompted = isClaudeTranscriptRootPrompt(row)
        } else if (!planned.covered?.has(String(row.uuid))) {
          await items.loadRow(row, input.providerSessionId)
          await staging.restore(row)
        }
      }
      if (tail) {
        for (const row of tail.rows) {
          await restore(row)
          await yieldTurn()
        }
      } else {
        await recoverClaudeTranscript({ filePath, signal, restore, yieldTurn })
      }
      complete = true
      return await staging.finish()
    } finally {
      staging.dispose()
    }
  }
}

/** The newest saved root row Claude's transcript names, as the chat holds it: its uuid. */
async function newestClaudeRow(
  reads: Pick<StructuredAgentSessionHistoryJournal['reads'], 'visitItems'>,
  providerSessionId: string
): Promise<string | undefined> {
  let newest: { uuid: string; sequence: number; index: number } | undefined
  await reads.visitItems({ kinds: ['message'] }, (key, sequence, _body, linkage, item) => {
    const identity = parseAgentJournalItemKey(key)
    if (
      !isRootAgentJournalItem(linkage) ||
      identity?.provider !== 'claude' ||
      identity.sessionId !== providerSessionId
    ) {
      return
    }
    const index = item.sequenceIndex ?? 0
    if (
      !newest ||
      sequence > newest.sequence ||
      (sequence === newest.sequence && index > newest.index)
    ) {
      newest = { uuid: identity.uuid, sequence, index }
    }
  })
  return newest?.uuid
}

/** A saved streamed block's message may have been cut short: its rows are read again. */
function claudeTranscriptLeaf(key: string): { throughMessage?: string } {
  return key.startsWith('block:')
    ? { throughMessage: key.slice('block:'.length, key.lastIndexOf(':')) }
    : {}
}
