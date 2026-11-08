import { join } from 'node:path'
import { isRootAgentJournalItem } from '../../shared/agent-session/journal/agent-session-journal-producer'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import {
  captureHistoryCatchUpView,
  runHistoryCatchUp
} from '../native-chat/agent-session-wire/acquisition/structured-agent-session-history-catch-up'
import type { AgentJournalCursor } from '../../shared/agent-session/journal/agent-session-journal-identity'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { createClaudeTranscriptImportPlan } from './claude-transcript-import-plan'
import { readClaudeTranscriptTail } from './claude-transcript-tail'

const DEFAULT_CLAUDE_CATCH_UP_TIMEOUT_MS = 30_000
type ClaudeHistoryView = {
  physicalCursor: AgentJournalCursor
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
        return { hasRows, newest }
      }),
    prepare: async ({ view, journal, signal, check, yieldTurn, warn }) => {
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
      const tail = await readClaudeTranscriptTail({ filePath, leafUuid: input.leafUuid, check })
      check()
      if (!tail) {
        warn('leaf-not-in-tail')
        return null
      }
      complete = true
      const staging = createClaudeTranscriptImportPlan({
        sessionId: input.sessionId,
        providerSessionId: input.providerSessionId,
        journal,
        rewound: planned.hasRows ? tail.rewound : null,
        check
      })
      try {
        for (const row of tail.rows) {
          staging.restore(row)
          await yieldTurn()
        }
        return staging.finish()
      } finally {
        staging.dispose()
      }
    }
  })
  return complete && (outcome === 'committed' || outcome === 'checked')
}
