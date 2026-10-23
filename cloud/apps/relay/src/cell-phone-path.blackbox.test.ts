import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reserveDeadManWindowMs } from './cell-reserve-dead-man.js'
import { openRelayDatabase } from './database.js'
import { nextFrame, RESERVE_MODE_CELL_ID, startReserveModeCell } from './test-fixtures/reserve-mode-cell.js'
import { StatementRecordingDatabase } from './test-fixtures/statement-recording-database.js'

// Step 6: a reserve-mode cell with phonePath=memory resumes paired phones without the database.

// Phone credentials are 32 random bytes.
const token = (fill: number) => Buffer.alloc(32, fill).toString('base64url')
const TOKEN = token(1)
const OTHER_CELL = { id: 'production-gce-c4', url: 'https://c4.relay.onorca.dev', capacityRequests: 900 }

// A paired phone's accept and attach with the switch off, as main issued them at 9ea54343710.
const DATABASE_PATH_ACCEPT = [
  'SELECT * FROM relay_devices WHERE relay_host_id = ? AND (current_hash = ? OR grace_hash = ?)',
  'SELECT assignment.*, cell.cell_url, region.region FROM relay_assignments assignment JOIN relay_cells cell ON cell.cell_id = assignment.cell_id LEFT JOIN relay_cell_regions region ON region.cell_id = cell.cell_id WHERE assignment.user_id = ? AND assignment.relay_host_id = ?',
  'BEGIN',
  'SELECT * FROM relay_invites WHERE relay_host_id = ? AND token_hash = ?',
  'SELECT * FROM relay_devices WHERE relay_host_id = ? AND (current_hash = ? OR grace_hash = ?)',
  'COMMIT',
  'BEGIN',
  'SELECT * FROM relay_assignments WHERE user_id = ? AND relay_host_id = ? [locked]',
  'SELECT * FROM relay_assignment_activity_leases WHERE user_id = ? AND relay_host_id = ? ORDER BY activity_id ASC [locked]',
  'UPDATE relay_assignments SET pending_confirmations = CASE WHEN pending_confirmations + ? < 0 THEN 0 ELSE pending_confirmations + ? END, lease_expires_at = CASE WHEN lease_expires_at > ? THEN lease_expires_at ELSE ? END, last_activity_at = ? WHERE user_id = ? AND relay_host_id = ?',
  'INSERT INTO relay_assignment_activity_leases (user_id, relay_host_id, activity_id, activity_kind, cell_id, request_units, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  'UPDATE relay_cells SET reserved_requests = CASE WHEN reserved_requests + ? < 0 THEN 0 ELSE reserved_requests + ? END, updated_at = ? WHERE cell_id = ? AND (? <= 0 OR reserved_requests + ? <= capacity_requests) RETURNING cell_id',
  'COMMIT',
  'BEGIN',
  'SELECT * FROM relay_assignments WHERE user_id = ? AND relay_host_id = ? [locked]',
  'SELECT * FROM relay_assignment_activity_leases WHERE user_id = ? AND relay_host_id = ? ORDER BY activity_id ASC [locked]',
  'UPDATE relay_assignments SET reserved_splices = CASE WHEN reserved_splices + ? < 0 THEN 0 ELSE reserved_splices + ? END, lease_expires_at = CASE WHEN lease_expires_at > ? THEN lease_expires_at ELSE ? END, last_activity_at = ? WHERE user_id = ? AND relay_host_id = ?',
  'INSERT INTO relay_assignment_activity_leases (user_id, relay_host_id, activity_id, activity_kind, cell_id, request_units, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  'UPDATE relay_cells SET reserved_requests = CASE WHEN reserved_requests + ? < 0 THEN 0 ELSE reserved_requests + ? END, updated_at = ? WHERE cell_id = ? AND (? <= 0 OR reserved_requests + ? <= capacity_requests) RETURNING cell_id',
  'COMMIT',
  'INSERT INTO relay_connection_bases (basis_conn_id, user_id, relay_host_id, relay_device_id, owning_control_generation, credential_kind, invite_token_hash, accepted_credential_version, accepted_as, deadline, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
]

const CONFIRM_DEVICE_READ =
  'SELECT * FROM relay_devices WHERE user_id = ? AND relay_host_id = ? AND relay_device_id = ?'

// The flag-off confirm, as main issued it at 9ea54343710.
const DATABASE_PATH_CONFIRM = [
  'BEGIN',
  'SELECT basis_conn_id, result_json FROM relay_confirm_results WHERE user_id = ? AND relay_host_id = ? AND req_id = ?',
  'SELECT * FROM relay_connection_bases WHERE basis_conn_id = ?',
  'UPDATE relay_devices SET updated_at = updated_at WHERE user_id = ? AND relay_host_id = ? AND relay_device_id = ?',
  'SELECT * FROM relay_devices WHERE user_id = ? AND relay_host_id = ? AND relay_device_id = ?',
  'UPDATE relay_devices SET current_expires_at = ?, updated_at = ? WHERE user_id = ? AND relay_host_id = ? AND relay_device_id = ?',
  'INSERT INTO relay_confirm_results (user_id, relay_host_id, req_id, basis_conn_id, tuple_json, result_json, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  'INSERT INTO relay_audit_events (id, at, type, user_id, relay_host_id, relay_device_id, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
  'COMMIT',
  'BEGIN',
  'SELECT * FROM relay_assignments WHERE user_id = ? AND relay_host_id = ? [locked]',
  'SELECT * FROM relay_assignment_activity_leases WHERE user_id = ? AND relay_host_id = ? ORDER BY activity_id ASC [locked]',
  'DELETE FROM relay_assignment_activity_leases WHERE user_id = ? AND relay_host_id = ? AND activity_id = ?',
  'UPDATE relay_assignments SET pending_confirmations = CASE WHEN pending_confirmations + ? < 0 THEN 0 ELSE pending_confirmations + ? END, lease_expires_at = CASE WHEN lease_expires_at > ? THEN lease_expires_at ELSE ? END, last_activity_at = ? WHERE user_id = ? AND relay_host_id = ?',
  'UPDATE relay_cells SET reserved_requests = CASE WHEN reserved_requests + ? < 0 THEN 0 ELSE reserved_requests + ? END, updated_at = ? WHERE cell_id = ? AND (? <= 0 OR reserved_requests + ? <= capacity_requests) RETURNING cell_id',
  'COMMIT'
]

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
    const reserve = await startReserveModeCell({ database, dataDir, cleanup, ...(now ? { now } : {}) })
    // The admit-effective writer ticks on its own; every other statement is the phone's.
    const phoneStatements = () =>
      database.statements.filter((sql) => !sql.includes('relay_cell_admit_effective'))
    // The test's own reads and writes go around the recorder.
    return { ...reserve, database, raw: inner, phoneStatements }
  }

  async function seatedPhoneHost(phonePath: 'db' | 'memory') {
    const reserve = await cell()
    reserve.setAdmitMode('reserve', { phonePath })
    const seated = await reserve.bookedHost(3)
    await reserve.installDevice(seated.identity.hostId, TOKEN)
    reserve.database.statements.length = 0
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
    reserve.database.statements.length = 0
    // The desktop's confirm, sent in reply to the phone over the end-to-end channel.
    const confirm = async (reqId: string, basis = basisConnId) => {
      const answer = Promise.race([
        nextFrame(seated.socket, 'device-resume-confirmed'),
        nextFrame(seated.socket, 'control-error')
      ])
      seated.socket.send(JSON.stringify({ type: 'device-resume-confirm', v: 1, reqId, basisConnId: basis }))
      return await answer
    }
    return { reserve, seated, phone, basisConnId, confirm }
  }

  const deviceRow = async (reserve: Awaited<ReturnType<typeof cell>>) =>
    (await reserve.raw.query(`SELECT current_expires_at FROM relay_devices`))[0]

  const warnings = (event: string) =>
    vi
      .mocked(console.warn)
      .mock.calls.map(([line]) => String(line))
      .filter((line) => line.includes(event))
      .map((line) => JSON.parse(line))

  it('acts only while the cell is in reserve mode, so admitMode=db or a dead-man trip turns it off', async () => {
    let now = Date.now()
    const reserve = await cell(() => now)
    expect(reserve.relay.sessions.phonePathEffective()).toBe('db')
    reserve.setAdmitMode('reserve', { phonePath: 'memory' })
    expect(reserve.relay.sessions.phonePathEffective()).toBe('memory')
    reserve.setAdmitMode('db', { phonePath: 'memory' })
    expect(reserve.relay.sessions.phonePathEffective()).toBe('db')
    reserve.setAdmitMode('reserve', { phonePath: 'memory' })
    expect(reserve.relay.sessions.phonePathEffective()).toBe('memory')
    now += reserveDeadManWindowMs(reserve.config.cellId) + 1_000
    expect(reserve.relay.sessions.inReserveMode()).toBe(false)
    expect(reserve.relay.sessions.phonePathEffective()).toBe('db')
  })

  it('admits a seated phone resume from one device read and writes no activity lease', async () => {
    const { reserve, seated } = await seatedPhoneHost('memory')
    const connOpen = nextFrame(seated.socket, 'conn-open')
    const phone = await reserve.dialPhone(seated.identity.hostId, TOKEN)
    expect(await connOpen).toMatchObject({ kind: 'resume', relayDeviceId: 'device-1' })
    expect(reserve.phoneStatements()).toEqual([DATABASE_PATH_ACCEPT[0]])
    await reserve.attachData(await connOpen, seated.ack.generation)
    expect(await phone.hello).toMatchObject({ type: 'relay-hello', ok: true, credentialKind: 'resume' })
    expect(reserve.phoneStatements()).toEqual([DATABASE_PATH_ACCEPT[0]])
    expect(await reserve.activityLeases()).toEqual([])
  })

  it('keeps the database path statement for statement while phonePath is db', async () => {
    const { reserve, seated } = await seatedPhoneHost('db')
    const connOpen = nextFrame(seated.socket, 'conn-open')
    const phone = await reserve.dialPhone(seated.identity.hostId, TOKEN)
    await reserve.attachData(await connOpen, seated.ack.generation)
    expect(await phone.hello).toMatchObject({ type: 'relay-hello', ok: true })
    expect(reserve.phoneStatements()).toEqual(DATABASE_PATH_ACCEPT)
  })

  it('closes a revoked or expired device 4401 and never tries it as an invite', async () => {
    const reserve = await cell()
    reserve.setAdmitMode('reserve', { phonePath: 'memory' })
    const seated = await reserve.bookedHost(3)
    await reserve.installDevice(seated.identity.hostId, token(2), { revokedAt: Date.now() - 1_000 })
    await reserve.installDevice(seated.identity.hostId, token(3), {
      relayDeviceId: 'device-2',
      expiresAt: Date.now() - 1_000
    })
    for (const refused of [token(2), token(3)]) {
      reserve.database.statements.length = 0
      const phone = await reserve.dialPhone(seated.identity.hostId, refused)
      expect(await phone.hello).toEqual({ type: 'relay-hello', ok: false, code: 4401 })
      expect((await phone.closed).code).toBe(4401)
      expect(reserve.phoneStatements()).toEqual([DATABASE_PATH_ACCEPT[0]])
    }
  })

  it('closes 4503 when the device read fails, without trying the invite path', async () => {
    const { reserve, seated } = await seatedPhoneHost('memory')
    vi.spyOn(reserve.relay.store, 'lookupResume').mockRejectedValue(new Error('connection terminated'))
    const invite = vi.spyOn(reserve.relay.store, 'resolveInviteForMove')
    for (let dial = 0; dial < 2; dial += 1) {
      const phone = await reserve.dialPhone(seated.identity.hostId, TOKEN)
      expect((await phone.closed).code).toBe(4503)
    }
    expect(invite).not.toHaveBeenCalled()
    expect(reserve.phoneStatements()).toEqual([])
    // One line opens the window; the repeat waits for its closing line.
    expect(warnings('orca_relay_client_accept_db_error')).toEqual([
      { event: 'orca_relay_client_accept_db_error', cause: 'error', cellId: reserve.config.cellId }
    ])
  })

  it('falls through to the invite path only when no device row matches', async () => {
    const { reserve, seated } = await seatedPhoneHost('memory')
    const created = nextFrame(seated.socket, 'invite-created')
    seated.socket.send(JSON.stringify({ type: 'invite-create', reqId: 'invite-1', relayDeviceId: 'device-9' }))
    const invite = await created
    const connOpen = nextFrame(seated.socket, 'conn-open')
    await reserve.dialPhone(seated.identity.hostId, String(invite.inviteToken))
    expect(await connOpen).toMatchObject({ kind: 'invite', relayDeviceId: 'device-9' })
    // Invites keep today's leases: install validates their basis in Postgres.
    expect((await reserve.activityLeases()).map((lease) => lease.activity_kind)).toEqual(['invite', 'invite'])
  })

  it('answers a phone whose host has no seat here from one assignment read', async () => {
    const reserve = await cell()
    reserve.setAdmitMode('reserve', { phonePath: 'memory' })
    await reserve.relay.assignments.reconcileCells([...reserve.config.cells, OTHER_CELL])
    const dial = async (row: 'elsewhere' | 'here' | 'none') => {
      const host = await reserve.host()
      if (row !== 'none') await reserve.insertRow(host.hostId, 3, row === 'here' ? reserve.config.cellId : OTHER_CELL.id)
      await reserve.installDevice(host.hostId, TOKEN)
      reserve.database.statements.length = 0
      const phone = await reserve.dialPhone(host.hostId, TOKEN)
      const closed = await phone.closed
      expect(reserve.phoneStatements()).toEqual(DATABASE_PATH_ACCEPT.slice(0, 2))
      return closed.code
    }
    expect(await dial('elsewhere')).toBe(4409)
    expect(await dial('none')).toBe(4404)
    expect(warnings('orca_relay_client_miss_row_names_here')).toEqual([])
    expect(await dial('here')).toBe(4404)
    expect(warnings('orca_relay_client_miss_row_names_here')).toEqual([
      expect.objectContaining({ cellId: reserve.config.cellId, relayHostIdDigest: expect.any(String) })
    ])
    vi.spyOn(reserve.relay.assignments, 'resolve').mockRejectedValueOnce(new Error('connection terminated'))
    const host = await reserve.host()
    await reserve.installDevice(host.hostId, TOKEN)
    expect((await (await reserve.dialPhone(host.hostId, TOKEN)).closed).code).toBe(4409)
    expect(warnings('orca_relay_client_miss_read_error')).toEqual([
      { event: 'orca_relay_client_miss_read_error', cause: 'error', cellId: reserve.config.cellId }
    ])
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
    expect((await reserve.activityLeases()).map((lease) => lease.activity_kind)).toEqual(['confirmation'])
  })

  it('confirms from the memory basis with one fresh read, renewing a device due for it', async () => {
    const { reserve, confirm } = await splicedPhone('memory')
    const before = Number((await deviceRow(reserve))?.current_expires_at)
    const answer = await confirm('confirm-1')
    expect(answer).toMatchObject({ type: 'device-resume-confirmed', reqId: 'confirm-1', renewed: true, acceptedAs: 'current' })
    const after = Number((await deviceRow(reserve))?.current_expires_at)
    expect(after).toBeGreaterThan(before)
    expect(answer.resumeExpiresAt).toBe(after)
    expect(reserve.phoneStatements()).toEqual([
      CONFIRM_DEVICE_READ,
      expect.stringMatching(/^UPDATE relay_devices SET current_expires_at = \?.*RETURNING current_expires_at$/)
    ])
    expect(await reserve.activityLeases()).toEqual([])
    // Its audit row leaves with the next batch.
    await reserve.relay.store.resumeAudit.flush()
    const audits = await reserve.raw.query(
      `SELECT detail_json FROM relay_audit_events WHERE type = 'resume-confirmed'`
    )
    expect(audits.map((row) => JSON.parse(String(row.detail_json)))).toEqual([
      { reqId: 'confirm-1', basisConnId: expect.any(String), renewed: true }
    ])
    // A retry of the same request answers from memory; another basis cannot reuse its reqId.
    reserve.database.statements.length = 0
    expect(await confirm('confirm-1')).toEqual(answer)
    expect(reserve.phoneStatements()).toEqual([])
    expect(await confirm('confirm-1', 'another-basis')).toMatchObject({
      type: 'control-error',
      code: 'confirmation_tuple_mismatch'
    })
  })

  it('answers renewed:true with the stored expiry when renewal is not due, or its write fails', async () => {
    const fresh = Date.now() + 29.5 * 24 * 60 * 60 * 1000
    const notDue = await splicedPhone('memory', { expiresAt: fresh })
    expect(await notDue.confirm('confirm-1')).toMatchObject({ renewed: true, resumeExpiresAt: fresh })
    expect(notDue.reserve.phoneStatements()).toEqual([CONFIRM_DEVICE_READ])

    const due = Date.now() + 20 * 24 * 60 * 60 * 1000
    const failing = await splicedPhone('memory', { expiresAt: due })
    failing.reserve.database.failing = (sql) => sql.startsWith('UPDATE relay_devices')
    expect(await failing.confirm('confirm-1')).toMatchObject({ renewed: true, resumeExpiresAt: due })
    expect(Number((await deviceRow(failing.reserve))?.current_expires_at)).toBe(due)
    // Never silent: a renewal left failing ages phones toward re-pairing.
    expect(warnings('orca_relay_resume_renewal_failed')).toEqual([
      { event: 'orca_relay_resume_renewal_failed', cause: 'error', cellId: failing.reserve.config.cellId }
    ])
  })

  it('confirms from memory after the switch turned off between accept and confirm, taking no lease', async () => {
    const { reserve, confirm } = await splicedPhone('memory')
    reserve.setAdmitMode('reserve', { phonePath: 'db' })
    expect(await confirm('confirm-1')).toMatchObject({ type: 'device-resume-confirmed', renewed: true })
    expect(reserve.phoneStatements()[0]).toBe(CONFIRM_DEVICE_READ)
    expect(await reserve.activityLeases()).toEqual([])
  })

  it('replays a stored answer after its splice closed, and drops the basis itself', async () => {
    const { reserve, phone, confirm } = await splicedPhone('memory')
    const answer = await confirm('confirm-1')
    phone.socket.close()
    await phone.closed
    await new Promise((resolve) => setTimeout(resolve, 50))
    reserve.database.statements.length = 0
    expect(await confirm('confirm-1')).toEqual(answer)
    expect(await confirm('confirm-1', 'another-basis')).toMatchObject({ code: 'confirmation_tuple_mismatch' })
    expect(reserve.phoneStatements()).toEqual([])
    // A new request on the closed basis finds none in memory, so it goes to the database.
    expect(await confirm('confirm-2')).toMatchObject({ code: 'confirmation_not_active' })
    expect(reserve.phoneStatements()[0]).toBe('BEGIN')
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
    expect(reserve.phoneStatements()).toEqual([CONFIRM_DEVICE_READ])
  })

  it('answers every device change since the accept read as the database confirm does', async () => {
    const changes: Record<string, [string, unknown[]]> = {
      revoked: ['UPDATE relay_devices SET revoked_at = ?', [Date.now() - 1]],
      expired: ['UPDATE relay_devices SET current_expires_at = ?', [Date.now() - 1]],
      retired: ["UPDATE relay_devices SET current_hash = 'rotated-twice', current_version = 3, grace_version = 2", []],
      unchanged: ['UPDATE relay_devices SET updated_at = updated_at', []]
    }
    const outcome = async (phonePath: 'db' | 'memory', [sql, params]: [string, unknown[]]) => {
      const { reserve, confirm } = await splicedPhone(phonePath)
      await reserve.raw.query(sql, params)
      const answer = await confirm('confirm-1')
      return answer.type === 'control-error' ? answer.code : `${answer.type}:${answer.acceptedAs}:${answer.renewed}`
    }
    for (const [name, change] of Object.entries(changes)) {
      expect(await outcome('memory', change), name).toBe(await outcome('db', change))
    }
    expect(await outcome('memory', changes.revoked!)).toBe('reject-revoked')
  })

  it('sends a confirm with no memory basis to the database, which holds none either', async () => {
    const { reserve, phone, confirm } = await splicedPhone('memory')
    phone.socket.close()
    await phone.closed
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await confirm('confirm-1')).toMatchObject({ type: 'control-error', code: 'confirmation_not_active' })
    expect(reserve.phoneStatements()[0]).toBe('BEGIN')
    expect(warnings('orca_relay_resume_confirm_failed')).toEqual([
      {
        event: 'orca_relay_resume_confirm_failed',
        code: 'confirmation_not_active',
        phonePath: 'db',
        cellId: reserve.config.cellId
      }
    ])
  })

  it('does not count a lease release that failed after a committed confirm as a failed confirm', async () => {
    const { reserve, confirm } = await splicedPhone('db')
    vi.spyOn(reserve.relay.assignments, 'releaseActivity').mockRejectedValueOnce(new Error('connection terminated'))
    // As today, the desktop still hears the release failure.
    expect(await confirm('confirm-1')).toMatchObject({ type: 'control-error' })
    expect(warnings('orca_relay_resume_confirm_failed')).toEqual([])
  })

  it('keeps the database confirm statement for statement while phonePath is db', async () => {
    const { reserve, confirm } = await splicedPhone('db')
    expect(await confirm('confirm-1')).toMatchObject({ type: 'device-resume-confirmed', renewed: true })
    expect(reserve.phoneStatements()).toEqual(DATABASE_PATH_CONFIRM)
  })

  describe('rolling a memory cell back', () => {
    // Flip back by the switch, or by the dead-man; either way the confirm finishes from memory.
    type Cell = Awaited<ReturnType<typeof cell>>
    type Advance = (ms: number) => void
    type Rollback = { beforeDial?: (advance: Advance) => void; roll: (reserve: Cell, advance: Advance) => void }
    // The dead-man trips just after the phone's accept: its window ran from the host's booking.
    const window = reserveDeadManWindowMs(RESERVE_MODE_CELL_ID)
    const rollbacks: Record<string, Rollback> = {
      'admitMode=db': { roll: (reserve) => reserve.setAdmitMode('db', { phonePath: 'memory' }) },
      'phonePath=db': { roll: (reserve) => reserve.setAdmitMode('reserve', { phonePath: 'db' }) },
      'a dead-man trip': { beforeDial: (advance) => advance(window - 5_000), roll: (_reserve, advance) => advance(6_000) }
    }

    for (const [name, rollback] of Object.entries(rollbacks)) {
      it(`finishes an in-flight confirm on its memory basis after ${name}, writing and leaking no lease`, async () => {
        let now = Date.now()
        const advance: Advance = (ms) => {
          now += ms
        }
        const spliced = await splicedPhone('memory', {}, {
          now: () => now,
          beforeDial: () => rollback.beforeDial?.(advance)
        })
        const { reserve, seated } = spliced
        // The flag tool records reserve in Postgres before the cell admits from memory.
        await reserve.relay.assignments.reconcileCells([...reserve.config.cells, OTHER_CELL])
        await reserve.relay.assignments.setCellAdmitMode(reserve.config.cellId, 'reserve')
        rollback.roll(reserve, advance)
        expect(reserve.relay.sessions.phonePathEffective()).toBe('db')
        reserve.database.statements.length = 0
        expect(await spliced.confirm('confirm-1')).toMatchObject({ type: 'device-resume-confirmed', renewed: true })
        expect(reserve.phoneStatements().filter((sql) => !sql.includes('relay_assignment'))).toEqual([
          CONFIRM_DEVICE_READ,
          expect.stringMatching(/^UPDATE relay_devices SET current_expires_at/)
        ])
        // Only the control lease a flip back re-registers; nothing for the phone.
        const leases = async () => (await reserve.activityLeases()).map((lease) => lease.activity_kind)
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
        // Let a flip back finish leasing its control (and fold its relay_cells write) first.
        await until(async () => reserve.relay.sessions.reregistrationPending() === 0)
        await new Promise((resolve) => setTimeout(resolve, 250))
        reserve.database.statements.length = 0
        spliced.phone.socket.close()
        await spliced.phone.closed
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(reserve.phoneStatements()).toEqual([])
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
      seated.socket.send(JSON.stringify({ type: 'device-resume-confirm', v: 1, reqId, basisConnId }))
      return await answer
    }
    const splice = async (fill: number) => {
      await reserve.installDevice(seated.identity.hostId, token(fill), { relayDeviceId: `device-${fill}` })
      const connOpen = nextFrame(seated.socket, 'conn-open')
      const phone = await reserve.dialPhone(seated.identity.hostId, token(fill))
      const basisConnId = String((await connOpen).connId)
      const data = await reserve.attachData(await connOpen, seated.ack.generation)
      expect(await phone.hello).toMatchObject({ ok: true })
      return { phone, data, basisConnId }
    }
    const confirmed = await splice(1)
    expect(await confirm('confirm-a', confirmed.basisConnId)).toMatchObject({ type: 'device-resume-confirmed' })
    const inFlight = await splice(2)

    reserve.database.failing = () => true
    // A seated phone keeps working.
    const relayed = new Promise<string>((resolve) =>
      confirmed.data.once('message', (frame) => resolve(String(frame)))
    )
    confirmed.phone.socket.send('still here')
    expect(await relayed).toBe('still here')
    // A new resume and a confirm fail cleanly; nothing crashes.
    expect((await (await reserve.dialPhone(seated.identity.hostId, token(1))).closed).code).toBe(4503)
    expect(await confirm('confirm-b', inFlight.basisConnId)).toMatchObject({ type: 'control-error' })
    // Flipped back during the block: the in-flight confirm still finishes on its memory basis.
    reserve.setAdmitMode('db', { phonePath: 'memory' })
    reserve.database.failing = null
    reserve.database.statements.length = 0
    expect(await confirm('confirm-c', inFlight.basisConnId)).toMatchObject({ type: 'device-resume-confirmed' })
    expect(reserve.phoneStatements().filter((sql) => !sql.includes('relay_assignment'))[0]).toBe(CONFIRM_DEVICE_READ)
    // And new resumes take the database path again.
    const connOpen = nextFrame(seated.socket, 'conn-open')
    await reserve.dialPhone(seated.identity.hostId, token(1))
    expect(await connOpen).toMatchObject({ kind: 'resume' })

    // Audit rows held past 10 minutes of outage are dropped and counted, never written late.
    reserve.database.failing = (sql) => sql.startsWith('INSERT INTO relay_audit_events')
    now += 11 * 60 * 1000
    await reserve.relay.store.resumeAudit.flush()
    reserve.database.failing = null
    const written = await reserve.raw.query(`SELECT id FROM relay_audit_events WHERE type = 'resume-confirmed'`)
    expect(written).toEqual([])
    expect(reserve.relay.runtimeCounts().resumeAuditDropped).toBe(2)
  })
})

