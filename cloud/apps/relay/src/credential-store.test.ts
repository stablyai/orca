import { describe, expect, it } from 'vitest'
import {
  hashCredential,
  RelayCredentialStore,
  type CredentialReservation,
  type RelayIdentity
} from './credential-store.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'

const identity: RelayIdentity = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
const relayDeviceId = 'device-1'

async function inviteBasis(
  store: RelayCredentialStore,
  generation = 1
): Promise<{ reservation: CredentialReservation; basisConnId: string }> {
  const invite = await store.createInvite(identity, relayDeviceId)
  const reservation = await store.reserveCredential(identity.relayHostId, invite.inviteToken)
  if (!reservation) throw new Error('invite did not reserve')
  const basisConnId = `basis-${generation}`
  await store.recordConnectionBasis({
    ...reservation,
    basisConnId,
    owningControlGeneration: generation,
    deadline: reservation.leaseExpiresAt
  })
  return { reservation, basisConnId }
}

describe('relay credential store', () => {
  it('issues invites with a skew margin under the client-side TTL ceiling', async () => {
    const database = await openInMemoryRelayDatabase()
    const store = new RelayCredentialStore(database, () => 1_000_000)
    const invite = await store.createInvite(identity, relayDeviceId)
    // Zero-tolerance released desktops reject expiry past local now + 10min;
    // issuing 30s under the ceiling absorbs that much desktop clock lag.
    expect(invite.expiresAt).toBe(1_000_000 + 10 * 60 * 1_000 - 30 * 1_000)
  })

  it('persists one invite reservation with bounded attempts and cooldown', async () => {
    let now = 100
    const database = await openInMemoryRelayDatabase()
    const store = new RelayCredentialStore(database, () => now)
    const invite = await store.createInvite(identity, relayDeviceId)
    const first = await store.reserveCredential(identity.relayHostId, invite.inviteToken, 'first')
    expect(first).toMatchObject({ credentialKind: 'invite', reservationId: 'first' })
    expect(await store.reserveCredential(identity.relayHostId, invite.inviteToken, 'second')).toBeNull()
    now = first!.leaseExpiresAt
    expect(await store.reserveCredential(identity.relayHostId, invite.inviteToken, 'second')).toBeNull()
    await database.query(`UPDATE relay_invites SET cooldown_until = ? WHERE token_hash = ?`, [
      now,
      hashCredential(invite.inviteToken)
    ])
    expect(await store.reserveCredential(identity.relayHostId, invite.inviteToken, 'second')).toMatchObject({
      reservationId: 'second'
    })
    await database.close()
  })

  it('validates director moves without reservation and enforces account-global mint rate', async () => {
    const database = await openInMemoryRelayDatabase()
    const store = new RelayCredentialStore(database, () => 100)
    const invite = await store.createInvite(identity, relayDeviceId)
    expect(await store.validateInviteForMove(identity.relayHostId, invite.inviteToken)).toBe(true)
    const rows = await database.query(`SELECT state, attempt_count FROM relay_invites WHERE token_hash = ?`, [
      hashCredential(invite.inviteToken)
    ])
    expect(rows[0]).toMatchObject({ state: 'available', attempt_count: 0 })
    for (let index = 1; index < 30; index++) {
      await store.createInvite(identity, `device-${index + 1}`)
    }
    await expect(store.createInvite(identity, 'device-over-limit')).rejects.toMatchObject({
      code: 'rate_limit_exceeded'
    })
    expect(await database.query(`SELECT * FROM relay_audit_events`)).toHaveLength(30)
    await database.close()
  })

  it('serializes relay-basis and authenticated-direct under one global result', async () => {
    const database = await openInMemoryRelayDatabase()
    const store = new RelayCredentialStore(database, () => 100)
    const { basisConnId } = await inviteBasis(store)
    await store.recordDirectAuthorization({
      ...identity,
      relayDeviceId,
      directAuthId: 'direct-1',
      owningControlGeneration: 1,
      deadline: 1_000
    })
    const base = {
      ...identity,
      relayDeviceId,
      reqId: 'req-1',
      newResumeTokenHash: hashCredential('pending-resume'),
      owningControlGeneration: 1
    }
    const [relay, direct] = await Promise.all([
      store.installCredential({
        ...base,
        authorization: { mode: 'relay-basis' as const, basisConnId }
      }),
      store.installCredential({
        ...base,
        authorization: { mode: 'authenticated-direct' as const, directAuthId: 'direct-1' }
      })
    ])
    expect(relay).toEqual(direct)
    expect(relay.currentVersion).toBe(1)
    expect(await store.installStatus(base)).toEqual(relay)
    const devices = await database.query(`SELECT * FROM relay_devices`)
    expect(devices).toHaveLength(1)
    await database.close()
  })

  it('rolls back token and invite effects when result persistence fails', async () => {
    const database = await openInMemoryRelayDatabase()
    const normalStore = new RelayCredentialStore(database, () => 100)
    const { basisConnId, reservation } = await inviteBasis(normalStore)
    const fault: RelayDatabase = {
      query: (sql, params) => database.query(sql, params),
      queryLocked: (sql, params) => database.queryLocked(sql, params),
      close: () => database.close(),
      transaction: async (operation) =>
        await database.transaction(async (transaction) =>
          await operation({
            query: async (sql, params) => {
              if (sql.includes('INSERT INTO relay_install_results')) throw new Error('injected SQL failure')
              return await transaction.query(sql, params)
            },
            queryLocked: (sql, params) => transaction.queryLocked(sql, params),
            transaction: (nested) => transaction.transaction(nested),
            close: () => transaction.close()
          })
        )
    }
    const faultStore = new RelayCredentialStore(fault, () => 100)
    const input = {
      ...identity,
      relayDeviceId,
      reqId: 'req-fault',
      newResumeTokenHash: hashCredential('pending-resume'),
      owningControlGeneration: 1,
      authorization: { mode: 'relay-basis' as const, basisConnId }
    }
    await expect(faultStore.installCredential(input)).rejects.toThrow('injected SQL failure')
    expect(await normalStore.installStatus(input)).toBeNull()
    expect(await database.query(`SELECT * FROM relay_devices`)).toEqual([])
    const invites = await database.query(`SELECT state FROM relay_invites WHERE token_hash = ?`, [
      reservation.tokenHash
    ])
    expect(invites[0]?.state).toBe('reserved')
    await database.close()
  })

  it('renews only a tuple-bound current credential and replays its committed result', async () => {
    let now = 100
    const database = await openInMemoryRelayDatabase()
    const store = new RelayCredentialStore(database, () => now)
    const { basisConnId } = await inviteBasis(store)
    const resumeToken = 'resume-token-1'
    await store.installCredential({
      ...identity,
      relayDeviceId,
      reqId: 'install-1',
      newResumeTokenHash: hashCredential(resumeToken),
      owningControlGeneration: 1,
      authorization: { mode: 'relay-basis', basisConnId }
    })
    const reservation = await store.reserveCredential(identity.relayHostId, resumeToken)
    if (!reservation) throw new Error('resume did not reserve')
    expect(await store.resolveResume(identity.relayHostId, resumeToken)).toEqual({
      userId: identity.userId,
      relayDeviceId
    })
    await store.recordConnectionBasis({
      ...reservation,
      basisConnId: 'resume-basis',
      owningControlGeneration: 1,
      deadline: 1_000
    })
    now = 200
    const confirmed = await store.confirmResume({
      ...identity,
      reqId: 'confirm-1',
      basisConnId: 'resume-basis',
      owningControlGeneration: 1
    })
    expect(confirmed).toMatchObject({ renewed: true, acceptedAs: 'current' })
    await store.deactivateBasis('resume-basis')
    expect(
      await store.confirmResume({
        ...identity,
        reqId: 'confirm-1',
        basisConnId: 'resume-basis',
        owningControlGeneration: 1
      })
    ).toEqual(confirmed)
    await expect(
      store.confirmResume({
        ...identity,
        reqId: 'confirm-1',
        basisConnId: 'other-basis',
        owningControlGeneration: 1
      })
    ).rejects.toMatchObject({ code: 'confirmation_tuple_mismatch' })
    await database.close()
  })

  it('leaves a now-grace version unchanged and rejects late, expired, and revoked tuples', async () => {
    let now = 100
    const database = await openInMemoryRelayDatabase()
    const store = new RelayCredentialStore(database, () => now)
    const { basisConnId } = await inviteBasis(store)
    const firstToken = 'resume-token-1'
    const first = await store.installCredential({
      ...identity,
      relayDeviceId,
      reqId: 'install-1',
      newResumeTokenHash: hashCredential(firstToken),
      owningControlGeneration: 1,
      authorization: { mode: 'relay-basis', basisConnId }
    })
    const firstReservation = await store.reserveCredential(identity.relayHostId, firstToken)
    if (!firstReservation) throw new Error('first resume did not reserve')
    await store.recordConnectionBasis({
      ...firstReservation,
      basisConnId: 'grace-basis',
      owningControlGeneration: 1,
      deadline: 100_000_000
    })
    await store.recordDirectAuthorization({
      ...identity,
      relayDeviceId,
      directAuthId: 'rotate-direct',
      owningControlGeneration: 1,
      deadline: 1_000
    })
    now = 200
    await store.installCredential({
      ...identity,
      relayDeviceId,
      reqId: 'install-2',
      newResumeTokenHash: hashCredential('resume-token-2'),
      expectedCurrentHash: hashCredential(firstToken),
      owningControlGeneration: 1,
      authorization: { mode: 'authenticated-direct', directAuthId: 'rotate-direct' }
    })
    const grace = await store.confirmResume({
      ...identity,
      reqId: 'confirm-grace',
      basisConnId: 'grace-basis',
      owningControlGeneration: 1
    })
    expect(grace).toMatchObject({ acceptedAs: 'current', renewed: false, currentVersion: 2 })
    expect(grace.resumeExpiresAt).toBeGreaterThan(first.resumeExpiresAt)

    now += 24 * 60 * 60 * 1000 + 1
    await expect(
      store.confirmResume({
        ...identity,
        reqId: 'confirm-expired-grace',
        basisConnId: 'grace-basis',
        owningControlGeneration: 1
      })
    ).rejects.toMatchObject({ code: 'reject-expired' })

    const currentReservation = await store.reserveCredential(identity.relayHostId, 'resume-token-2')
    if (!currentReservation) throw new Error('current resume did not reserve')
    await store.recordConnectionBasis({
      ...currentReservation,
      basisConnId: 'revoked-basis',
      owningControlGeneration: 1,
      deadline: now + 1_000
    })
    await store.revoke(identity, relayDeviceId)
    await expect(
      store.confirmResume({
        ...identity,
        reqId: 'confirm-revoked',
        basisConnId: 'revoked-basis',
        owningControlGeneration: 1
      })
    ).rejects.toMatchObject({ code: 'reject-revoked' })

    await store.recordConnectionBasis({
      ...currentReservation,
      basisConnId: 'late-basis',
      owningControlGeneration: 1,
      deadline: now - 1
    })
    await expect(
      store.confirmResume({
        ...identity,
        reqId: 'confirm-late',
        basisConnId: 'late-basis',
        owningControlGeneration: 1
      })
    ).rejects.toMatchObject({ code: 'confirmation_not_active' })
    await database.close()
  })
})
