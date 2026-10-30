import { vi } from 'vitest'
import { MessageQuestionIngest } from './message-question-ingest'
import { queryTranscriptCurrentQuestions } from './transcript-current-questions'
import * as transcriptFs from './wsl-transcript-fs-access'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'
import { messageQuestionOccurrenceSchema } from '../../shared/message-question-occurrence'
import { cleanup } from './transcript-current-questions-test-fixture'
import type { fixture } from './transcript-current-questions-test-fixture'

export function clearRow(id: string) {
  return `${JSON.stringify({ type: 'fixture_context_clear', id })}\n`
}
export function decodeWithClear(line: string, fallback: string) {
  const message = decodeCodexTranscriptLine(line, fallback)
  if (message) {
    return message
  }
  const row = JSON.parse(line)
  // Canonical adapter only: the Codex JSONL decoder does not itself produce clear rows.
  if (row.type !== 'fixture_context_clear') {
    return null
  }
  return {
    id: row.id,
    role: 'system' as const,
    source: 'transcript' as const,
    timestamp: null,
    blocks: [
      {
        type: 'text' as const,
        text: 'Context cleared',
        contextClear: { operationId: row.id, afterFence: 0, clearedAt: 0 }
      }
    ]
  }
}
export function stopRow(id: string) {
  return `${JSON.stringify({ type: 'event_msg', payload: { id, type: 'turn_aborted' } })}\n`
}
export function longOutput(id: string, bytes: number) {
  return `${JSON.stringify({
    type: 'response_item',
    payload: {
      id,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '😀'.repeat(Math.ceil(bytes / 4)) }]
    }
  })}\n`
}
export function sourceIo(path: string) {
  const ranges: { start: number; end: number; bytes: number; chunks: number }[] = []
  const counts = { stats: 0, probes: 0, validationBytes: 0, destroyed: 0 }
  let beforeNext: ((range: (typeof ranges)[number]) => Promise<void | 'short'>) | undefined
  const open = transcriptFs.openTranscriptReadStream
  vi.spyOn(transcriptFs, 'openTranscriptReadStream').mockImplementation(
    (file, options, ...rest) => {
      const stream = open(file, options, ...rest)
      if (file !== path) {
        return stream
      }
      const range = { start: options.start ?? 0, end: options.end ?? -1, bytes: 0, chunks: 0 }
      ranges.push(range)
      const iterator = stream[Symbol.asyncIterator]()
      const next = iterator.next.bind(iterator)
      vi.spyOn(iterator, 'next').mockImplementation(async (...args) => {
        if ((await beforeNext?.(range)) === 'short') {
          await iterator.return?.()
          return { done: true, value: undefined }
        }
        const result = await next(...args)
        if (!result.done) {
          range.bytes += Buffer.byteLength(result.value)
          range.chunks++
        }
        return result
      })
      vi.spyOn(stream, Symbol.asyncIterator).mockReturnValue(iterator)
      stream.once('close', () => {
        counts.destroyed++
      })
      return stream
    }
  )
  const stat = transcriptFs.transcriptFileStat
  vi.spyOn(transcriptFs, 'transcriptFileStat').mockImplementation((file, ...args) => {
    if (file === path) {
      counts.stats++
    }
    return stat(file, ...args)
  })
  const slice = transcriptFs.readTranscriptSlice
  vi.spyOn(transcriptFs, 'readTranscriptSlice').mockImplementation(async (file, ...args) => {
    const bytes = await slice(file, ...args)
    if (file === path) {
      counts.probes++
      counts.validationBytes += bytes.length
    }
    return bytes
  })
  return {
    ranges,
    counts,
    onNext: (hook: typeof beforeNext) => {
      beforeNext = hook
    }
  }
}
export function sourceOperations(f: Awaited<ReturnType<typeof fixture>>) {
  const counts = { selects: 0, writes: 0, definitions: 0 }
  const seen = new WeakSet<object>()
  const prepare = f.database.db.prepare.bind(f.database.db)
  vi.spyOn(f.database.db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql)
    if (!seen.has(statement)) {
      seen.add(statement)
      const get = statement.get.bind(statement),
        all = statement.all.bind(statement),
        run = statement.run.bind(statement)
      vi.spyOn(statement, 'get').mockImplementation((...args) => {
        if (sql.startsWith('SELECT')) {
          counts.selects++
        }
        return get(...args)
      })
      vi.spyOn(statement, 'all').mockImplementation((...args) => {
        if (sql.startsWith('SELECT')) {
          counts.selects++
        }
        return all(...args)
      })
      vi.spyOn(statement, 'run').mockImplementation((...args) => {
        counts.writes++
        return run(...args)
      })
    }
    return statement
  })
  const schema = vi.spyOn(messageQuestionOccurrenceSchema, 'parse')
  const ingest = vi.spyOn(MessageQuestionIngest.prototype, 'append')
  const reconcile = vi.spyOn(f.repository, 'reconcile')
  const stringify = vi.spyOn(JSON, 'stringify')
  return {
    counts,
    schema,
    ingest,
    reconcile,
    stringify,
    reset: () => {
      counts.selects = counts.writes = counts.definitions = 0
      schema.mockClear()
      ingest.mockClear()
      reconcile.mockClear()
      stringify.mockClear()
    },
    summary: () => ({
      ...counts,
      schema: schema.mock.calls.length,
      ingest: ingest.mock.calls.length,
      repository: reconcile.mock.calls.length,
      definitionJson: stringify.mock.calls.filter(
        ([value]) =>
          value !== null &&
          typeof value === 'object' &&
          ('responseMode' in value || 'asyncQuestions' in value)
      ).length
    })
  }
}
export function sourceQuery(
  f: Awaited<ReturnType<typeof fixture>>,
  session: string,
  decode = decodeWithClear
) {
  const source = {
    kind: 'transcript' as const,
    filePath: f.path,
    agent: 'codex',
    sessionId: session
  }
  cleanup.push(() => f.repository.deleteSource(source))
  return {
    source,
    read: () =>
      queryTranscriptCurrentQuestions(
        f.path,
        'codex',
        session,
        decode,
        (projection) => projection,
        undefined,
        f.repository
      )
  }
}
