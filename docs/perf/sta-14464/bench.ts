// STA-14464 harness: measures the real session-search purge paths against a synthetic index.
// Usage: pnpm exec tsx docs/perf/sta-14464/bench.ts <populate|measure> <db> [messages] [sessions]
import { existsSync, statSync } from 'node:fs'
import { setImmediate as tick } from 'node:timers/promises'
import { loadavg } from 'node:os'
import { setActiveSink, withSpan } from '../../../src/main/observability/tracer'
import { SessionSearchStore } from '../../../src/main/ai-vault-search/storage/session-search-store'
import { SessionSearchToolPurge } from '../../../src/main/ai-vault-search/storage/session-search-tool-purge'
import { insertSearchMessage } from '../../../src/main/ai-vault-search/storage/session-search-message-rows'

const [mode, path, messagesArg = '1000000', sessionsArg = '5000'] = process.argv.slice(2)
const spans: { name: string; durationMs: number }[] = []
setActiveSink({
  push: (t: { name: string; durationMs: number }) =>
    spans.push({ name: t.name, durationMs: t.durationMs }),
  flush() {},
  close() {}
} as never)

let seed = 42
const rand = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const VOCAB = Array.from({ length: 6000 }, (_, i) => `w${i.toString(36)}${'abcdefgh'[i % 8]}`)
const words = (n: number): string =>
  Array.from({ length: n }, () => VOCAB[Math.floor(rand() * rand() * VOCAB.length)]).join(' ')

function populate(): void {
  if (existsSync(path)) {
    throw new Error(`${path} exists`)
  }
  const total = Number(messagesArg)
  const sessions = Number(sessionsArg)
  const store = new SessionSearchStore(path)
  const db = store.connection
  const now = Date.now()
  const started = performance.now()
  let written = 0
  for (let s = 0; s < sessions; s++) {
    if (s % 200 === 0) {
      db.exec('BEGIN')
    }
    const filePath = `/home/u/.claude/projects/p${s % 40}/${s}.jsonl`
    const id = Number(
      db
        .prepare(`INSERT INTO sessions(agent, session_id, file_path, title, cwd, cwd_key, updated_at, message_count, resume_command)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          'claude',
          `sid-${s}`,
          filePath,
          words(6),
          `/p${s % 40}`,
          `/p${s % 40}`,
          new Date(now - s * 60_000).toISOString(),
          0,
          'claude --resume x'
        ).lastInsertRowid
    )
    db.prepare(
      `INSERT INTO files(path, byte_offset, mtime_ms, size_bytes, session_row_id) VALUES (?, ?, ?, ?, ?)`
    ).run(filePath, 1000, now - s * 60_000, 1000, id)
    const count = Math.floor(total / sessions) + (s < total % sessions ? 1 : 0)
    for (let m = 0; m < count; m++) {
      insertSearchMessage(db, id, {
        role: m % 2 ? 'assistant' : 'user',
        text: words(20 + Math.floor(rand() * 60)),
        timestamp: new Date(now - s * 60_000 + m).toISOString()
      })
      written++
    }
    if (s % 200 === 199 || s === sessions - 1) {
      db.exec('COMMIT')
      process.stdout.write(`\r${written}/${total}`)
    }
  }
  store.close()
  console.log(
    `\npopulated ${written} messages, ${sessions} sessions in ${((performance.now() - started) / 1000).toFixed(1)}s, ${(statSync(path).size / 1e6).toFixed(0)} MB`
  )
}

const ORPHAN_PROBE = `SELECT session_row_id FROM messages
     WHERE session_row_id NOT IN (SELECT id FROM sessions) LIMIT 1`
const time = (fn: () => unknown): number => {
  const t = performance.now()
  fn()
  return performance.now() - t
}
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return { median: +s[Math.floor(s.length / 2)].toFixed(2), max: +s.at(-1).toFixed(2), n: s.length }
}

async function measure(): Promise<void> {
  const reps = 7
  const out: Record<string, unknown> = {
    load: loadavg(),
    dbMB: +(statSync(path).size / 1e6).toFixed(0)
  }
  const store = new SessionSearchStore(path)
  const db = store.connection
  out.rows = db.prepare('SELECT count(*) AS n FROM messages').get()
  out.sessions = db.prepare('SELECT count(*) AS n FROM sessions').get()
  out.plan = db
    .prepare(`EXPLAIN QUERY PLAN ${ORPHAN_PROBE}`)
    .all()
    .map((r) => r.detail)

  // No-load control: indexed point reads on the same connection and cache.
  const point = db.prepare('SELECT id FROM messages WHERE session_row_id = ? LIMIT 1')
  out.control_point_read_ms = stats(
    Array.from({ length: reps }, (_, i) => time(() => point.get(i + 1)))
  )

  out.orphan_probe_ms = stats(
    Array.from({ length: reps }, () => time(() => db.prepare(ORPHAN_PROBE).get()))
  )

  // The field span: worker-entry's withSpan around purgeOlderThan; no file is old enough to expire.
  const purge: number[] = []
  for (let i = 0; i < reps; i++) {
    spans.length = 0
    await withSpan('aiVault.search.purge', () => store.purgeOlderThan(0))
    purge.push(spans.find((s) => s.name === 'aiVault.search.purge')!.durationMs)
    await tick()
  }
  out.purge_span_ms = stats(purge)

  // Tool-row purge (#40134): first pass without the persisted mark, then steady state.
  const toolPass = async (): Promise<number> => {
    const t = performance.now()
    await new SessionSearchToolPurge(
      db,
      () => false,
      () => undefined,
      (e) => {
        throw e
      }
    ).request()
    return performance.now() - t
  }
  db.prepare(
    "DELETE FROM meta WHERE key IN ('tool_purge_scanned_rowid','tool_purge_floor_rowid')"
  ).run()
  out.tool_purge_first_pass_ms = +(await toolPass()).toFixed(1)
  out.tool_purge_steady_ms = stats(
    await Promise.all([] as Promise<number>[]).then(async () => {
      const xs: number[] = []
      for (let i = 0; i < reps; i++) {
        xs.push(await toolPass())
      }
      return xs
    })
  )
  store.close()
  console.log(JSON.stringify(out, null, 2))
}

if (mode === 'populate') {
  populate()
} else {
  void measure()
}
