import { afterEach, describe, expect, it, vi } from 'vitest'
import { openInMemoryRelayDatabase, type RelayDatabase, type SqlRow } from './database.js'
import {
  RESUME_AUDIT_BUFFER_MAX_ROWS,
  RESUME_AUDIT_FLUSH_MS,
  RESUME_AUDIT_FLUSH_ROWS,
  RESUME_AUDIT_MAX_AGE_MS,
  ResumeConfirmedAuditBuffer
} from './resume-confirmed-audit-buffer.js'
import { StatementRecordingDatabase } from './test-fixtures/statement-recording-database.js'

const event = (reqId: string) => ({
  userId: 'user-1',
  relayHostId: 'host000000000001',
  relayDeviceId: 'device-1',
  detail: { reqId, basisConnId: `basis-${reqId}`, renewed: true }
})

describe('the batched resume-confirmed audit', () => {
  let inner: RelayDatabase | undefined

  afterEach(async () => {
    await inner?.close()
    inner = undefined
  })

  async function setup(now: () => number = Date.now) {
    inner = await openInMemoryRelayDatabase()
    const database = new StatementRecordingDatabase(inner)
    const lines: Array<Record<string, unknown>> = []
    const buffer = new ResumeConfirmedAuditBuffer(database, now, (line) =>
      lines.push(JSON.parse(line))
    )
    const rows = async (): Promise<SqlRow[]> =>
      await inner!.query(
        `SELECT type, relay_device_id, detail_json FROM relay_audit_events ORDER BY at, id`
      )
    return { database, buffer, lines, rows }
  }

  it('writes buffered rows as one multi-row insert', async () => {
    const { database, buffer, rows } = await setup()
    for (const reqId of ['a', 'b', 'c']) buffer.add(event(reqId))
    expect(await rows()).toEqual([])
    await buffer.flush()
    expect(database.statements).toEqual([
      expect.stringMatching(/^INSERT INTO relay_audit_events .* ON CONFLICT \(id\) DO NOTHING$/)
    ])
    expect((await rows()).map((row) => JSON.parse(String(row.detail_json)).reqId).sort()).toEqual(['a', 'b', 'c'])
    expect((await rows())[0]).toMatchObject({ type: 'resume-confirmed', relay_device_id: 'device-1' })
    buffer.stop()
  })

  it('flushes at once when a batch fills, without waiting for the timer', async () => {
    const { database, buffer, rows } = await setup()
    const inserted = Promise.withResolvers<void>()
    const query = database.query.bind(database)
    database.query = async (sql, params) => {
      const result = await query(sql, params)
      inserted.resolve()
      return result
    }
    try {
      for (let index = 0; index < RESUME_AUDIT_FLUSH_ROWS - 1; index += 1) {
        buffer.add(event(`r${index}`))
      }
      expect(database.statements).toEqual([])
      buffer.add(event('last'))
      expect(database.statements).toHaveLength(1)
      await inserted.promise
      expect(await rows()).toHaveLength(RESUME_AUDIT_FLUSH_ROWS)
    } finally {
      buffer.stop()
    }
  })

  it('retries a flush whose commit outcome was lost without writing any row twice', async () => {
    const { database, buffer, rows } = await setup()
    buffer.add(event('a'))
    buffer.add(event('b'))
    // The insert commits, then the reply is lost.
    const query = database.query.bind(database)
    let lost = true
    database.query = async (sql, params) => {
      const result = await query(sql, params)
      if (lost) {
        lost = false
        throw new Error('Connection terminated unexpectedly')
      }
      return result
    }
    await buffer.flush()
    expect(buffer.pending()).toBe(2)
    await buffer.flush()
    expect(buffer.pending()).toBe(0)
    expect(await rows()).toHaveLength(2)
    buffer.stop()
  })

  it('caps the buffer through an outage and drops rows too old to retry, counting both', async () => {
    let now = 1_000_000
    const { database, buffer, lines, rows } = await setup(() => now)
    database.failing = () => true
    for (let index = 0; index <= RESUME_AUDIT_BUFFER_MAX_ROWS; index += 1) buffer.add(event(`r${index}`))
    // The batch the 500th row sent fails and comes back: rows in flight count toward the cap.
    await buffer.flush()
    expect(buffer.pending()).toBe(RESUME_AUDIT_BUFFER_MAX_ROWS)
    expect(lines).toEqual([{ event: 'orca_relay_resume_audit_dropped', overflow: 1, aged: 0 }])
    now += RESUME_AUDIT_MAX_AGE_MS
    database.failing = null
    await buffer.flush()
    expect(buffer.drops()).toEqual({ overflow: 1, aged: RESUME_AUDIT_BUFFER_MAX_ROWS })
    expect(lines.at(-1)).toEqual({
      event: 'orca_relay_resume_audit_dropped',
      overflow: 1,
      aged: RESUME_AUDIT_BUFFER_MAX_ROWS
    })
    expect(await rows()).toEqual([])
    // Quiet once nothing more is lost.
    await buffer.flush()
    expect(lines).toHaveLength(2)
    buffer.stop()
  })

  it('sends one early batch on crossing the batch size, and leaves retries to the timer', async () => {
    const { database, buffer } = await setup()
    database.failing = () => true
    for (let index = 0; index < RESUME_AUDIT_FLUSH_ROWS + 50; index += 1) buffer.add(event(`r${index}`))
    await buffer.flush()
    // The 50 adds past the batch size sent nothing more: no insert per confirm into a failing database.
    expect(database.statements).toHaveLength(1)
    buffer.stop()
  })

  it('does not restart periodic flushing after stop', async () => {
    vi.useFakeTimers()
    try {
      const { database, buffer } = await setup()
      buffer.stop()
      buffer.add(event('late'))
      await vi.advanceTimersByTimeAsync(RESUME_AUDIT_FLUSH_MS * 3)
      expect(database.statements).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
