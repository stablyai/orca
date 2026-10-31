import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { legacyItemBody } from '../native-chat/agent-session-journal/journal-legacy-import'
import { decodeOmpTranscriptLine } from '../native-chat/transcript-line-decoders-omp'
import {
  createHistoryCatchUpBatch,
  runHistoryCatchUp
} from '../native-chat/agent-session-wire/structured-agent-session-history-catch-up'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { journalLifecycleItemMutation } from '../native-chat/agent-session-journal/journal-row-builders'

const MAX_CHILD_FILES = 64
const MAX_CHILD_BYTES = 16 * 1024 * 1024
const sessionHeader = z.object({
  type: z.literal('session'),
  parentSession: z.string().optional()
})

type ChildRecord = { id: string; line: string; message: ReturnType<typeof decodeOmpTranscriptLine> }
type ChildFile = { id: string; path: string; records: ChildRecord[] }
type HistoryView = { existing: string; files: string }

export async function readOmpSubagentHistoryFiles(parentSession: string): Promise<ChildFile[]> {
  const directory = join(dirname(parentSession), basename(parentSession, extname(parentSession)))
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const files: ChildFile[] = []
  for (const entry of entries.slice(0, MAX_CHILD_FILES)) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl') || entry.name.endsWith('.tombstone')) {
      continue
    }
    const path = join(directory, entry.name)
    const text = await readFile(path, 'utf8').catch(() => '')
    if (Buffer.byteLength(text, 'utf8') > MAX_CHILD_BYTES) {
      continue
    }
    const lines = text.split('\n').filter(Boolean)
    let header: ReturnType<typeof sessionHeader.safeParse> | undefined
    for (const line of lines.slice(0, 8)) {
      try {
        const parsed = sessionHeader.safeParse(JSON.parse(line))
        if (parsed.success) {
          header = parsed
          break
        }
      } catch {
        // Continue to the session metadata line after optional title metadata.
      }
    }
    if (!header?.success || header.data.parentSession !== parentSession) {
      continue
    }
    const id = basename(entry.name, '.jsonl')
    const records: ChildRecord[] = []
    for (let index = 0; index < lines.length && records.length < 1024; index += 1) {
      let value: unknown
      try {
        value = JSON.parse(lines[index]!)
      } catch {
        continue
      }
      const record = z.record(z.string(), z.unknown()).safeParse(value)
      if (!record.success || typeof record.data.id !== 'string') {
        continue
      }
      const message = decodeOmpTranscriptLine(lines[index]!, record.data.id)
      if (message) {
        records.push({ id: record.data.id, line: lines[index]!, message })
      }
    }
    if (records.length > 0) {
      files.push({ id, path, records })
    }
  }
  return files
}

function existingChildIds(sink: StructuredAgentSessionEventSink): Set<string> {
  const ids = new Set<string>()
  sink.journalItems?.()?.visitItemsWithLinkage((_id, _sequence, _body, linkage) => {
    if (linkage.agentId) {
      ids.add(linkage.agentId)
    }
  })
  return ids
}

export async function importOmpSubagentHistory(input: {
  parentSession: string
  sink: StructuredAgentSessionEventSink | undefined
  signal?: AbortSignal
  logger?: (message: string, error?: unknown) => void
}): Promise<void> {
  if (
    !input.sink ||
    !input.sink.journalHistory ||
    !input.sink.journalItems ||
    !input.sink.tryAppendTransition
  ) {
    return
  }
  const files = await readOmpSubagentHistoryFiles(input.parentSession)
  if (files.length === 0) {
    return
  }
  const digest = createHash('sha256')
    .update(files.map((file) => file.path).join('\n'))
    .digest('hex')
  const result = await runHistoryCatchUp<HistoryView>({
    agentName: 'OMP',
    scope: 'omp-subagent-history',
    sessionId: input.parentSession,
    sink: input.sink,
    signal: input.signal,
    timeoutMs: 30_000,
    logger: { warn: input.logger ?? (() => {}), error: input.logger ?? (() => {}) },
    readView: (history) => ({
      existing: JSON.stringify([...existingChildIds(input.sink!)].sort()),
      files: `${history.epoch}:${digest}`
    }),
    sameView: (planned, current) =>
      planned.existing === current.existing && planned.files === current.files,
    prepare: async ({ journal, check }) => {
      const batch = createHistoryCatchUpBatch()
      const existing = existingChildIds(input.sink!)
      const imported: string[] = []
      for (const file of files) {
        check()
        if (existing.has(file.id)) {
          continue
        }
        for (const record of file.records) {
          check()
          if (!record.message) {
            continue
          }
          const identity: AgentJournalItemIdentity = {
            provider: 'legacy',
            agent: 'omp',
            sessionId: file.path,
            recordId: record.id
          }
          const key = agentJournalItemKey(identity)
          if (journal.item(journal.canonicalItemId(key)) !== null) {
            continue
          }
          batch.push(
            journalLifecycleItemMutation(
              {
                turnScope: AGENT_JOURNAL_THREAD_SCOPE,
                agentId: file.id,
                producerKind: 'agent'
              },
              identity,
              legacyItemBody(record.message)
            )
          )
          imported.push(key)
        }
      }
      return batch.size === 0 ? null : batch.finish('omp-subagent-history', [digest, imported])
    }
  })
  if (result === 'skipped') {
    input.logger?.('OMP subagent history catch-up was skipped')
  }
}
