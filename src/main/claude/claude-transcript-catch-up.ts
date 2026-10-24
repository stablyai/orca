import { join } from 'node:path'
import { isRootAgentJournalItem } from '../../shared/agent-session-journal-producer'
import { encodeClaudeProjectPaths } from '../ai-vault/claude-project-dir-encoding'
import { wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { runHistoryCatchUp } from '../native-chat/agent-session-wire/structured-agent-session-history-catch-up'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { createClaudeTranscriptImportPlan } from './claude-transcript-import-plan'
import { readClaudeTranscriptTail } from './claude-transcript-tail'

const DEFAULT_CLAUDE_CATCH_UP_TIMEOUT_MS = 30_000
type ClaudeHistoryView = {
  hasRows: boolean
  newest: { key: string; sequence: number; index: number } | null
}

// A chat's turn-end leaf is the newest transcript row it has shown. Anything Claude wrote after it
// came from another process on the same conversation (a terminal `claude --resume`), or from this
// chat's own turn cut off before its end was recorded; rows the chat already holds are skipped.

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
      return { hasRows, newest }
    },
    sameView: (planned, current) =>
      planned.newest?.key === current.newest?.key &&
      planned.newest?.sequence === current.newest?.sequence &&
      planned.newest?.index === current.newest?.index,
    prepare: async ({ view, journal, signal, check, yieldTurn, warn }) => {
      const claudeProjectsDir = join(input.claudeConfigDir, 'projects')
      let filePath: string | null = null
      for (const project of encodeClaudeProjectPaths(input.cwd)) {
        check()
        const candidate = join(claudeProjectsDir, project, `${input.providerSessionId}.jsonl`)
        const info = await wslGatedStat(candidate, 'exact', signal).catch(() => null)
        check()
        if (info?.isFile()) {
          filePath = candidate
          break
        }
      }
      // A moved project can leave its transcript in the original cwd's bucket.
      filePath ??= await resolveSessionFilePath(
        'claude',
        input.providerSessionId,
        { claudeProjectsDir },
        signal
      )
      check()
      if (!filePath) {
        return null
      }
      const planned = view()
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
