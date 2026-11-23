import { prepareClaudeTranscriptCapacityRecovery } from './claude-transcript-capacity-recovery'
import {
  nativeCopyIds,
  usableJournalHistoryOrigin,
  type JournalHistoryOrigin
} from '../../native-chat/agent-session-journal/context-epochs/journal-history-origin'
import { recoverClaudeTranscript } from './claude-transcript-recovery'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import type { StructuredAgentSessionEventSink } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import {
  HistoryCatchUpCapacityError,
  createHistoryCatchUpBatch,
  captureHistoryCatchUpView,
  runHistoryCatchUp
} from '../../native-chat/agent-session-wire/acquisition/structured-agent-session-history-catch-up'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { resolveSessionFilePath } from '../../native-chat/session-file-resolver'
import { createClaudeTranscriptImportPlan } from './claude-transcript-import-plan'
import {
  CLAUDE_TRANSCRIPT_WINDOW_MAX_BYTES,
  readClaudeTranscriptFrontier,
  readClaudeTranscriptTail
} from './claude-transcript-tail'
import {
  claudeTranscriptItemKeys,
  createClaudeTranscriptItemReader
} from './claude-transcript-item-reader'

/** What a live Claude session knows about its transcript, plus a catch-up that may still be running. */
export type ClaudeSessionHistory = {
  leafUuid: string | null
  covered: boolean
  contextActivity: number
  recovery?: Promise<void>
  startRecovery?: () => void
}

const DEFAULT_CLAUDE_CATCH_UP_TIMEOUT_MS = 30_000
export type ClaudeTranscriptCatchUpOutcome = boolean | { kind: 'capacity'; deadline: number }
type ClaudeHistoryView = {
  physicalCursor: AgentJournalCursor
  origin: JournalHistoryOrigin | null
  covered?: ReadonlySet<string>
  hasRows: boolean
  newest: { key: string; sequence: number; index: number } | null
}

/** Display-only reconciliation; capacity recovery runs in a separate invocation after open. */
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
  maxBytes?: number
  mode?: 'recovery'
  logger?: StructuredAgentSessionLogger
}): Promise<ClaudeTranscriptCatchUpOutcome> {
  let complete = false
  let capacity: { kind: 'capacity'; deadline: number } | undefined
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
    prepare: async ({ view, history, signal, deadline, check, yieldTurn, warn }) => {
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
      if (input.mode === 'recovery') {
        const plan = await prepareClaudeTranscriptCapacityRecovery(
          { ...input, filePath, physicalCursor: planned.physicalCursor },
          { history, signal, check, warn }
        )
        complete = 'operation' in plan
        return plan
      }
      const deferRecovery = () => {
        capacity = { kind: 'capacity', deadline }
        return null
      }
      const copy = usableJournalHistoryOrigin(planned.origin)
      const recovery = planned.covered && copy?.kind === 'native_copy' ? copy : null
      const copiedLeaf = recovery?.ids.at(-1) ?? input.leafUuid
      const sourceFrontier = recovery?.sourceFrontier
      if (recovery?.sourceConsumedBytes !== undefined) {
        const { size, mtimeMs } = await stat(filePath)
        check()
        if (
          size === recovery.sourceConsumedBytes &&
          (sourceFrontier !== undefined || mtimeMs === recovery.sourceMtimeMs)
        ) {
          const newestUuid = await readClaudeTranscriptFrontier({
            filePath,
            consumedBytes: size,
            maxBytes: input.maxBytes ?? CLAUDE_TRANSCRIPT_WINDOW_MAX_BYTES,
            check
          })
          check()
          if (newestUuid === sourceFrontier) {
            complete = true
            return createHistoryCatchUpBatch().finish('claude-history-unchanged', [
              planned.physicalCursor,
              size
            ])
          }
        }
      }
      const chainBoundaries = sourceFrontier ? [sourceFrontier, copiedLeaf] : []
      let leafAbsent = input.leafUuid === '' && !!planned.covered
      let tail = leafAbsent
        ? null
        : await readClaudeTranscriptTail({
            filePath,
            leafUuid: input.leafUuid,
            chainBoundaries,
            maxBytes: input.maxBytes,
            check,
            onLeafAbsent: () => {
              leafAbsent = true
            }
          })
      check()
      if (!tail && sourceFrontier) {
        leafAbsent = false
        tail = await readClaudeTranscriptTail({
          filePath,
          leafUuid: sourceFrontier,
          chainBoundaries,
          maxBytes: input.maxBytes,
          check,
          onLeafAbsent: () => {
            leafAbsent = true
          }
        })
        check()
      }
      // Ordinary copy receipts can still bridge from their last imported leaf.
      if (!tail && !leafAbsent && !sourceFrontier && copiedLeaf !== input.leafUuid) {
        tail = await readClaudeTranscriptTail({
          filePath,
          leafUuid: copiedLeaf,
          maxBytes: input.maxBytes,
          check
        })
        check()
      }
      if (!tail && !(leafAbsent && planned.covered)) {
        if (!leafAbsent) {
          return deferRecovery()
        }
        warn('leaf-not-in-tail')
        return null
      }
      try {
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
          (tail?.rows ?? []).flatMap((row) =>
            claudeTranscriptItemKeys(row, input.providerSessionId)
          )
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
      } catch (error) {
        if (!(error instanceof HistoryCatchUpCapacityError)) {
          throw error
        }
        check()
        return deferRecovery()
      }
    }
  })
  return outcome === 'nothing' && capacity
    ? capacity
    : complete && (outcome === 'committed' || outcome === 'checked')
}
