import {
  nativeCopyIds,
  usableJournalHistoryOrigin,
  type JournalHistoryOrigin
} from '../native-chat/agent-session-journal/context-epochs/journal-history-origin'
import { recoverClaudeTranscript } from './claude-transcript-recovery'
import { join } from 'node:path'
import { isRootAgentJournalItem } from '../../shared/agent-session/journal/agent-session-journal-producer'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { runHistoryCatchUp } from '../native-chat/agent-session-wire/acquisition/structured-agent-session-history-catch-up'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { createClaudeTranscriptImportPlan } from './claude-transcript-import-plan'
import { readClaudeTranscriptTail } from './claude-transcript-tail'

const DEFAULT_CLAUDE_CATCH_UP_TIMEOUT_MS = 30_000
type ClaudeHistoryView = {
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
    readView: (history): ClaudeHistoryView => {
      let hasRows = false
      let newest: { key: string; sequence: number; index: number } | null = null
      history.visitItemsWithLinkage((key, sequence, body, linkage) => {
        hasRows = true
        if (body.kind !== 'turn' || !isRootAgentJournalItem(linkage)) {
          return
        }
        const index = history.item(key)?.sequenceIndex ?? 0
        if (
          !newest ||
          sequence > newest.sequence ||
          (sequence === newest.sequence && index > newest.index)
        ) {
          newest = { key, sequence, index }
        }
      })
      const origin = history.historyOrigin()
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
    },
    sameView: (planned, current) =>
      planned.origin === current.origin &&
      planned.newest?.key === current.newest?.key &&
      planned.newest?.sequence === current.newest?.sequence &&
      planned.newest?.index === current.newest?.index,
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
      const planned = view()
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
      const staging = createClaudeTranscriptImportPlan({
        sessionId: input.sessionId,
        providerSessionId: input.providerSessionId,
        journal,
        rewound: planned.hasRows ? (tail?.rewound ?? true) : null,
        check
      })
      try {
        const restore = (row: Record<string, unknown>) => {
          check()
          if (!planned.covered?.has(String(row.uuid))) {
            staging.restore(row)
          }
        }
        if (tail) {
          for (const row of tail.rows) {
            restore(row)
            await yieldTurn()
          }
        } else {
          await recoverClaudeTranscript({ filePath, signal, restore, yieldTurn })
        }
        complete = true
        return staging.finish()
      } finally {
        staging.dispose()
      }
    }
  })
  return complete && (outcome === 'committed' || outcome === 'checked')
}
