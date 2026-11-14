import {
  nativeCopyIds,
  usableJournalHistoryOrigin,
  type JournalHistoryOrigin
} from '../../native-chat/agent-session-journal/context-epochs/journal-history-origin'
import { recoverClaudeTranscript } from './claude-transcript-recovery'
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
import {
  claudeTranscriptItemKeys,
  createClaudeTranscriptItemReader
} from './claude-transcript-item-reader'

const DEFAULT_CLAUDE_CATCH_UP_TIMEOUT_MS = 30_000
type ClaudeHistoryView = {
  physicalCursor: AgentJournalCursor
  origin: JournalHistoryOrigin | null
  covered?: ReadonlySet<string>
  hasRows: boolean
  newest: { key: string; sequence: number; index: number } | null
}

// Rows after the saved turn-end leaf come from an external resume or interrupted local turn; skip items already held.

/** Display only and optional: it never settles a send and never gates opening. */
export async function catchUpClaudeTranscript(input: {
  sessionId: string
  providerSessionId: string
  leafUuid: string
  claudeConfigDir: string
  cwd: string
  sink: StructuredAgentSessionEventSink
  signal?: AbortSignal
  assertCurrent?: () => void
  timeoutMs?: number
  logger?: StructuredAgentSessionLogger
}): Promise<boolean> {
  let complete = false
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
        await history.reads.visitItems(
          { kinds: ['turn'] },
          (key, sequence, _body, linkage, item) => {
            if (!isRootAgentJournalItem(linkage)) {
              return
            }
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
        return { hasRows, newest, origin, covered }
      }),
    prepare: async ({ view, history, signal, check, yieldTurn, warn }) => {
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
      const planned = await view()
      let leafAbsent = input.leafUuid === '' && !!planned.covered
      const tail = leafAbsent
        ? null
        : await readClaudeTranscriptTail({
            filePath,
            leafUuid: input.leafUuid,
            check,
            onLeafAbsent: () => {
              leafAbsent = true
            }
          })
      check()
      if (!tail && !(leafAbsent && planned.covered)) {
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
        rewound: planned.hasRows ? (tail?.rewound ?? true) : null,
        check
      })
      try {
        const restore = async (row: Record<string, unknown>) => {
          check()
          if (!planned.covered?.has(String(row.uuid))) {
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
  })
  return complete && (outcome === 'committed' || outcome === 'checked')
}
