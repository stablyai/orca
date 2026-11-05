import { afterEach, describe, expect, it } from 'vitest'
import { openInMemoryRelayDatabase, type RelayDatabase, type SqlRow } from '../database/database.js'
import { ResumeConfirmedAuditBuffer } from './resume-confirmed-audit-buffer.js'
import { StatementRecordingDatabase } from '../test-fixtures/statement-recording-database.js'

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

})
