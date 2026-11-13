import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reserveDeadManWindowMs } from '../cell/reservations/cell-reserve-dead-man.js'
import { openRelayDatabase } from '../database/database.js'
import {
  nextFrame,
  RESERVE_MODE_CELL_ID,
  startReserveModeCell
} from '../test-fixtures/reserve-mode-cell.js'
import { StatementRecordingDatabase } from '../test-fixtures/statement-recording-database.js'

// Step 6: a reserve-mode cell with phonePath=memory resumes paired phones without the database.

// Phone credentials are 32 random bytes.
const token = (fill: number) => Buffer.alloc(32, fill).toString('base64url')
const TOKEN = token(1)
const OTHER_CELL = {
  id: 'production-gce-c4',
  url: 'https://c4.relay.onorca.dev',
  capacityRequests: 900
}

async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('the memory phone path', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
    vi.restoreAllMocks()
  })

  async function cell(now?: () => number) {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const dataDir = mkdtempSync(join(tmpdir(), 'orca-relay-phone-path-'))
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
    const inner = await openRelayDatabase({ dataDir })
    cleanup.push(() => inner.close())
    const database = new StatementRecordingDatabase(inner)
    const reserve = await startReserveModeCell({
      database,
      dataDir,
      cleanup,
      ...(now ? { now } : {})
    })
    return { ...reserve, database, raw: inner }
  }

  async function seatedPhoneHost(phonePath: 'db' | 'memory') {
    const reserve = await cell()
    reserve.setAdmitMode('reserve', { phonePath })
    const seated = await reserve.bookedHost(3)
    await reserve.installDevice(seated.identity.hostId, TOKEN)
    return { reserve, seated }
  }

  // A phone resumed and spliced to its desktop, waiting to confirm.
  async function splicedPhone(
    phonePath: 'db' | 'memory',
    device: { expiresAt?: number } = {},
    clock: { now?: () => number; beforeDial?: () => void } = {}
  ) {
    const reserve = await cell(clock.now)
    reserve.setAdmitMode('reserve', { phonePath })
    const seated = await reserve.bookedHost(3)
    await reserve.installDevice(seated.identity.hostId, TOKEN, device)
    clock.beforeDial?.()
    const connOpen = nextFrame(seated.socket, 'conn-open')
    const phone = await reserve.dialPhone(seated.identity.hostId, TOKEN)
    const basisConnId = String((await connOpen).connId)
    await reserve.attachData(await connOpen, seated.ack.generation)
    expect(await phone.hello).toMatchObject({ ok: true })
    // The desktop's confirm, sent in reply to the phone over the end-to-end channel.
    const confirm = async (reqId: string, basis = basisConnId) => {
      const answer = Promise.race([
        nextFrame(seated.socket, 'device-resume-confirmed'),
        nextFrame(seated.socket, 'control-error')
      ])
      seated.socket.send(
        JSON.stringify({ type: 'device-resume-confirm', v: 1, reqId, basisConnId: basis })
      )
      return await answer
    }
    return { reserve, seated, phone, basisConnId, confirm }
  }

  const deviceRow = async (reserve: Awaited<ReturnType<typeof cell>>) =>
    (await reserve.raw.query(`SELECT current_expires_at FROM relay_devices`))[0]

  it('admits a seated phone resume without an activity lease', async () => {
    const { reserve, seated } = await seatedPhoneHost('memory')
    const connOpen = nextFrame(seated.socket, 'conn-open')
    const phone = await reserve.dialPhone(seated.identity.hostId, TOKEN)
    expect(await connOpen).toMatchObject({ kind: 'resume', relayDeviceId: 'device-1' })
    await reserve.attachData(await connOpen, seated.ack.generation)
    expect(await phone.hello).toMatchObject({
      type: 'relay-hello',
      ok: true,
      credentialKind: 'resume'
    })
    expect(await reserve.activityLeases()).toEqual([])
  })

  it('persists the connection basis and activity leases while phonePath is db', async () => {
    const { reserve, seated } = await seatedPhoneHost('db')
    const connOpen = nextFrame(seated.socket, 'conn-open')
    const phone = await reserve.dialPhone(seated.identity.hostId, TOKEN)
    await reserve.attachData(await connOpen, seated.ack.generation)
    expect(await phone.hello).toMatchObject({ type: 'relay-hello', ok: true })
    expect((await reserve.activityLeases()).map((lease) => lease.activity_kind).sort()).toEqual([
      'confirmation',
      'splice'
    ])
    expect(
      await reserve.raw.query(
        `SELECT basis_conn_id, relay_device_id, credential_kind, active FROM relay_connection_bases`
      )
    ).toEqual([
      {
        basis_conn_id: String((await connOpen).connId),
        relay_device_id: 'device-1',
        credential_kind: 'resume',
        active: 1
      }
    ])
  })

  it('closes a revoked or expired device 4401', async () => {
    const reserve = await cell()
    reserve.setAdmitMode('reserve', { phonePath: 'memory' })
    const seated = await reserve.bookedHost(3)
    await reserve.installDevice(seated.identity.hostId, token(2), { revokedAt: Date.now() - 1_000 })
    await reserve.installDevice(seated.identity.hostId, token(3), {
      relayDeviceId: 'device-2',
      expiresAt: Date.now() - 1_000
    })
    for (const refused of [token(2), token(3)]) {
      const phone = await reserve.dialPhone(seated.identity.hostId, refused)
      expect(await phone.hello).toEqual({ type: 'relay-hello', ok: false, code: 4401 })
      expect((await phone.closed).code).toBe(4401)
    }
  })

  it('falls through to the invite path only when no device row matches', async () => {
    const { reserve, seated } = await seatedPhoneHost('memory')
    const created = nextFrame(seated.socket, 'invite-created')
    seated.socket.send(
      JSON.stringify({ type: 'invite-create', reqId: 'invite-1', relayDeviceId: 'device-9' })
    )
    const invite = await created
    const connOpen = nextFrame(seated.socket, 'conn-open')
    await reserve.dialPhone(seated.identity.hostId, String(invite.inviteToken))
    expect(await connOpen).toMatchObject({ kind: 'invite', relayDeviceId: 'device-9' })
    // Invites keep today's leases: install validates their basis in Postgres.
    expect((await reserve.activityLeases()).map((lease) => lease.activity_kind)).toEqual([
      'invite',
      'invite'
    ])
  })

  it('distinguishes moved and offline hosts when a phone finds no seat here', async () => {
    const reserve = await cell()
    reserve.setAdmitMode('reserve', { phonePath: 'memory' })
    await reserve.relay.assignments.reconcileCells([...reserve.config.cells, OTHER_CELL])
    const dial = async (row: 'elsewhere' | 'here' | 'none') => {
      const host = await reserve.host()
      if (row !== 'none') {
        await reserve.insertRow(
          host.hostId,
          3,
          row === 'here' ? reserve.config.cellId : OTHER_CELL.id
        )
      }
      await reserve.installDevice(host.hostId, TOKEN)
      const phone = await reserve.dialPhone(host.hostId, TOKEN)
      const closed = await phone.closed
      return closed.code
    }
    expect(await dial('elsewhere')).toBe(4409)
    expect(await dial('none')).toBe(4404)
    expect(await dial('here')).toBe(4404)
    vi.spyOn(reserve.relay.assignments, 'resolve').mockRejectedValueOnce(
      new Error('connection terminated')
    )
    const host = await reserve.host()
    await reserve.installDevice(host.hostId, TOKEN)
    expect((await (await reserve.dialPhone(host.hostId, TOKEN)).closed).code).toBe(4409)
  })

  it('takes the database path for a phone whose switch turned off during its device read', async () => {
    const { reserve, seated } = await seatedPhoneHost('memory')
    const lookup = reserve.relay.store.lookupResume.bind(reserve.relay.store)
    vi.spyOn(reserve.relay.store, 'lookupResume').mockImplementation(async (...args) => {
      const found = await lookup(...args)
      reserve.setAdmitMode('reserve', { phonePath: 'db' })
      return found
    })
    const connOpen = nextFrame(seated.socket, 'conn-open')
    await reserve.dialPhone(seated.identity.hostId, TOKEN)
    expect(await connOpen).toMatchObject({ kind: 'resume' })
    expect((await reserve.activityLeases()).map((lease) => lease.activity_kind)).toEqual([
      'confirmation'
    ])
  })

  it('confirms from the memory basis and renews a device due for it', async () => {
    const { reserve, confirm } = await splicedPhone('memory')
    const before = Number((await deviceRow(reserve))?.current_expires_at)
    const answer = await confirm('confirm-1')
    expect(answer).toMatchObject({
      type: 'device-resume-confirmed',
      reqId: 'confirm-1',
      renewed: true,
      acceptedAs: 'current'
    })
    const after = Number((await deviceRow(reserve))?.current_expires_at)
    expect(after).toBeGreaterThan(before)
    expect(answer.resumeExpiresAt).toBe(after)
    expect(await reserve.activityLeases()).toEqual([])
    // Its audit row leaves with the next batch.
    await reserve.relay.store.resumeAudit.flush()
    const audits = await reserve.raw.query(
      `SELECT detail_json FROM relay_audit_events WHERE type = 'resume-confirmed'`
    )
    expect(audits.map((row) => JSON.parse(String(row.detail_json)))).toEqual([
      { reqId: 'confirm-1', basisConnId: expect.any(String), renewed: true }
    ])
    // A retry keeps its answer; another basis cannot reuse its reqId.
    expect(await confirm('confirm-1')).toEqual(answer)
    expect(await confirm('confirm-1', 'another-basis')).toMatchObject({
      type: 'control-error',
      code: 'confirmation_tuple_mismatch'
    })
  })

  it('answers renewed:true with the stored expiry when renewal is not due, or its write fails', async () => {
    const fresh = Date.now() + 29.5 * 24 * 60 * 60 * 1000
    const notDue = await splicedPhone('memory', { expiresAt: fresh })
    expect(await notDue.confirm('confirm-1')).toMatchObject({
      renewed: true,
      resumeExpiresAt: fresh
    })

    const due = Date.now() + 20 * 24 * 60 * 60 * 1000
    const failing = await splicedPhone('memory', { expiresAt: due })
    failing.reserve.database.failing = (sql) => sql.startsWith('UPDATE relay_devices')
    expect(await failing.confirm('confirm-1')).toMatchObject({
      renewed: true,
      resumeExpiresAt: due
    })
    expect(Number((await deviceRow(failing.reserve))?.current_expires_at)).toBe(due)
  })

  it('replays a stored answer after its splice closed, and drops the basis itself', async () => {
    const { phone, confirm } = await splicedPhone('memory')
    const answer = await confirm('confirm-1')
    phone.socket.close()
    await phone.closed
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await confirm('confirm-1')).toEqual(answer)
    expect(await confirm('confirm-1', 'another-basis')).toMatchObject({
      code: 'confirmation_tuple_mismatch'
    })
    // A new request on the closed basis finds none in memory, so it goes to the database.
    expect(await confirm('confirm-2')).toMatchObject({ code: 'confirmation_not_active' })
  })

  it('answers a grace-version confirm renewed:false with its expiry unchanged, as today', async () => {
    const { reserve, confirm } = await splicedPhone('memory')
    const stored = Number((await deviceRow(reserve))?.current_expires_at)
    // An install rotated the credential after the accept read, so the accepted version is grace.
    await reserve.raw.query(
      `UPDATE relay_devices SET grace_hash = current_hash, grace_version = 1, grace_expires_at = ?,
       current_hash = 'rotated', current_version = 2`,
      [Date.now() + 60_000]
    )
    expect(await confirm('confirm-1')).toMatchObject({
      type: 'device-resume-confirmed',
      currentVersion: 2,
      acceptedAs: 'current',
      renewed: false,
      resumeExpiresAt: stored
    })
  })

  it('durably confirms and renews a database-path resume, releasing only its confirmation lease', async () => {
    const { reserve, confirm, basisConnId } = await splicedPhone('db')
    const before = Number((await deviceRow(reserve))?.current_expires_at)
    const answer = await confirm('confirm-1')
    expect(answer).toMatchObject({ type: 'device-resume-confirmed', renewed: true })
    const after = Number((await deviceRow(reserve))?.current_expires_at)
    expect(after).toBeGreaterThan(before)
    expect(answer.resumeExpiresAt).toBe(after)
    const results = await reserve.raw.query(
      `SELECT req_id, basis_conn_id, result_json FROM relay_confirm_results`
    )
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ req_id: 'confirm-1', basis_conn_id: basisConnId })
    expect(JSON.parse(String(results[0]?.result_json))).toMatchObject({
      renewed: true,
      resumeExpiresAt: after
    })
    expect((await reserve.activityLeases()).map((lease) => lease.activity_kind)).toEqual(['splice'])
    expect(await confirm('confirm-1')).toEqual(answer)
  })

  describe('rolling a memory cell back', () => {
    // Flip back by the switch, or by the dead-man; either way the confirm finishes from memory.
    type Cell = Awaited<ReturnType<typeof cell>>
    type Advance = (ms: number) => void
    type Rollback = {
      beforeDial?: (advance: Advance) => void
      roll: (reserve: Cell, advance: Advance) => void
    }
    // The dead-man trips just after the phone's accept: its window ran from the host's booking.
    const window = reserveDeadManWindowMs(RESERVE_MODE_CELL_ID)
    const rollbacks: Record<string, Rollback> = {
      'admitMode=db': { roll: (reserve) => reserve.setAdmitMode('db', { phonePath: 'memory' }) },
      'phonePath=db': { roll: (reserve) => reserve.setAdmitMode('reserve', { phonePath: 'db' }) },
      'a dead-man trip': {
        beforeDial: (advance) => advance(window - 5_000),
        roll: (_reserve, advance) => advance(6_000)
      }
    }

    for (const [name, rollback] of Object.entries(rollbacks)) {
      it(`finishes an in-flight confirm on its memory basis after ${name}, writing and leaking no lease`, async () => {
        let now = Date.now()
        const advance: Advance = (ms) => {
          now += ms
        }
        const spliced = await splicedPhone(
          'memory',
          {},
          {
            now: () => now,
            beforeDial: () => rollback.beforeDial?.(advance)
          }
        )
        const { reserve, seated } = spliced
        // The flag tool records reserve in Postgres before the cell admits from memory.
        await reserve.relay.assignments.reconcileCells([...reserve.config.cells, OTHER_CELL])
        await reserve.relay.assignments.setCellAdmitMode(reserve.config.cellId, 'reserve')
        rollback.roll(reserve, advance)
        expect(reserve.relay.sessions.phonePathEffective()).toBe('db')
        expect(await spliced.confirm('confirm-1')).toMatchObject({
          type: 'device-resume-confirmed',
          renewed: true
        })
        // Only the control lease a flip back re-registers; nothing for the phone.
        const leases = async () =>
          (await reserve.activityLeases()).map((lease) => lease.activity_kind)
        expect((await leases()).filter((kind) => kind !== 'control')).toEqual([])
        // Postgres still records reserve, so evacuation leaves the cell alone.
        await expect(
          reserve.relay.assignments.startEvacuation(
            { userId: 'user-1', relayHostId: seated.identity.hostId },
            OTHER_CELL.id
          )
        ).rejects.toThrow('cell_in_reserve_mode')
        // The splice still runs, and closing it releases nothing it never took.
        expect(spliced.phone.socket.readyState).toBe(spliced.phone.socket.OPEN)
        await until(async () => reserve.relay.sessions.reregistrationPending() === 0)
        spliced.phone.socket.close()
        await spliced.phone.closed
        expect((await leases()).filter((kind) => kind !== 'control')).toEqual([])
      })
    }
  })

  // E-dep-6 in miniature: the staging drill blocks one memory cell's database for 10 minutes.
  it('rides out a database outage: splices keep forwarding, new work fails cleanly and recovers', async () => {
    let now = Date.now()
    const reserve = await cell(() => now)
    reserve.setAdmitMode('reserve', { phonePath: 'memory' })
    const seated = await reserve.bookedHost(3)
    const confirm = async (reqId: string, basisConnId: string) => {
      const answer = Promise.race([
        nextFrame(seated.socket, 'device-resume-confirmed'),
        nextFrame(seated.socket, 'control-error')
      ])
      seated.socket.send(
        JSON.stringify({ type: 'device-resume-confirm', v: 1, reqId, basisConnId })
      )
      return await answer
    }
    const splice = async (fill: number) => {
      await reserve.installDevice(seated.identity.hostId, token(fill), {
        relayDeviceId: `device-${fill}`
      })
      const connOpen = nextFrame(seated.socket, 'conn-open')
      const phone = await reserve.dialPhone(seated.identity.hostId, token(fill))
      const basisConnId = String((await connOpen).connId)
      const data = await reserve.attachData(await connOpen, seated.ack.generation)
      expect(await phone.hello).toMatchObject({ ok: true })
      return { phone, data, basisConnId }
    }
    const confirmed = await splice(1)
    expect(await confirm('confirm-a', confirmed.basisConnId)).toMatchObject({
      type: 'device-resume-confirmed'
    })
    const inFlight = await splice(2)

    reserve.database.failing = () => true
    // A seated phone keeps working.
    const relayed = new Promise<string>((resolve) =>
      confirmed.data.once('message', (frame) => resolve(String(frame)))
    )
    confirmed.phone.socket.send('still here')
    expect(await relayed).toBe('still here')
    // A new resume and a confirm fail cleanly; nothing crashes.
    expect((await (await reserve.dialPhone(seated.identity.hostId, token(1))).closed).code).toBe(
      4503
    )
    expect(await confirm('confirm-b', inFlight.basisConnId)).toMatchObject({
      type: 'control-error'
    })
    // Flipped back during the block: the in-flight confirm still finishes on its memory basis.
    reserve.setAdmitMode('db', { phonePath: 'memory' })
    reserve.database.failing = null
    expect(await confirm('confirm-c', inFlight.basisConnId)).toMatchObject({
      type: 'device-resume-confirmed'
    })
    // And new resumes take the database path again.
    const connOpen = nextFrame(seated.socket, 'conn-open')
    await reserve.dialPhone(seated.identity.hostId, token(1))
    expect(await connOpen).toMatchObject({ kind: 'resume' })

    // Audit rows held past 10 minutes of outage are dropped and counted, never written late.
    reserve.database.failing = (sql) => sql.startsWith('INSERT INTO relay_audit_events')
    now += 11 * 60 * 1000
    await reserve.relay.store.resumeAudit.flush()
    reserve.database.failing = null
    const written = await reserve.raw.query(
      `SELECT id FROM relay_audit_events WHERE type = 'resume-confirmed'`
    )
    expect(written).toEqual([])
    expect(reserve.relay.runtimeCounts().resumeAuditDropped).toBe(2)
  })
})
