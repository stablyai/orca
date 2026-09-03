import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  decideResumeCommit,
  RELAY_PROTOCOL_LIMITS,
  type DeviceCredentialInstalled,
  type DeviceResumeConfirmed
} from '@orca-cloud/relay-contract'
import type { RelayDatabase, SqlRow } from './database.js'

const CREDENTIAL_GRACE_MS = 24 * 60 * 60 * 1000
// Released desktops validate invite expiry against their own clock with zero
// tolerance at exactly inviteTtlMs; issuing under the ceiling keeps pairing
// working for clients whose clocks trail the cell by up to this margin.
const INVITE_ISSUE_SKEW_MARGIN_MS = 30 * 1000

export type RelayIdentity = { userId: string; relayHostId: string }
export type CredentialReservation = RelayIdentity & {
  credentialKind: 'invite' | 'resume'
  relayDeviceId: string
  tokenHash: string
  reservationId: string
  leaseExpiresAt: number
  acceptedCredentialVersion?: number
  acceptedAs?: 'current' | 'grace'
  resumeExpiresAt?: number
  graceExpiresAt?: number
}

export type InstallInput = RelayIdentity & {
  relayDeviceId: string
  reqId: string
  newResumeTokenHash: string
  expectedCurrentHash?: string
  owningControlGeneration: number
  authorization:
    | { mode: 'relay-basis'; basisConnId: string }
    | { mode: 'authenticated-direct'; directAuthId: string }
}

export class RelayStoreError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export function hashCredential(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

function equalHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function number(row: SqlRow, field: string): number {
  const value = Number(row[field])
  if (!Number.isSafeInteger(value)) throw new RelayStoreError(`invalid_${field}`)
  return value
}

function optionalNumber(row: SqlRow, field: string): number | undefined {
  return row[field] === null || row[field] === undefined ? undefined : number(row, field)
}

function string(row: SqlRow, field: string): string {
  const value = row[field]
  if (typeof value !== 'string') throw new RelayStoreError(`invalid_${field}`)
  return value
}

export class RelayCredentialStore {
  constructor(
    private readonly database: RelayDatabase,
    private readonly now: () => number = Date.now
  ) {}

  async createInvite(identity: RelayIdentity, relayDeviceId: string): Promise<{
    inviteToken: string
    expiresAt: number
    maxAttempts: number
  }> {
    const inviteToken = randomBytes(32).toString('base64url')
    const tokenHash = hashCredential(inviteToken)
    const now = this.now()
    const expiresAt = now + RELAY_PROTOCOL_LIMITS.inviteTtlMs - INVITE_ISSUE_SKEW_MARGIN_MS
    await this.database.transaction(async (transaction) => {
      await this.consumeRateWith(transaction, `account:${identity.userId}`, 'invite-mint', 30, 60_000, now)
      await transaction.query(
        `UPDATE relay_invites SET state = ?, updated_at = ?
         WHERE user_id = ? AND relay_host_id = ? AND relay_device_id = ?
           AND state IN (?, ?, ?)`,
        [
          'invalidated', now, identity.userId, identity.relayHostId, relayDeviceId,
          'available', 'reserved', 'cooldown'
        ]
      )
      await this.auditWith(transaction, {
        type: 'invite-created',
        ...identity,
        relayDeviceId,
        detail: { expiresAt }
      })
      await transaction.query(
        `INSERT INTO relay_invites
         (user_id, relay_host_id, relay_device_id, token_hash, state, attempt_count,
          max_attempts, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          identity.userId, identity.relayHostId, relayDeviceId, tokenHash, 'available', 0,
          RELAY_PROTOCOL_LIMITS.inviteMaxAttempts, expiresAt, now, now
        ]
      )
    })
    return { inviteToken, expiresAt, maxAttempts: RELAY_PROTOCOL_LIMITS.inviteMaxAttempts }
  }

  async reserveCredential(
    relayHostId: string,
    token: string,
    reservationId: string = randomUUID()
  ): Promise<CredentialReservation | null> {
    const tokenHash = hashCredential(token)
    const now = this.now()
    return await this.database.transaction(async (transaction) => {
      const inviteRows = await transaction.query(
        `SELECT * FROM relay_invites WHERE relay_host_id = ? AND token_hash = ?`,
        [relayHostId, tokenHash]
      )
      const invite = inviteRows[0]
      if (invite && equalHash(string(invite, 'token_hash'), tokenHash)) {
        const expiresAt = number(invite, 'expires_at')
        const attempts = number(invite, 'attempt_count')
        const maxAttempts = number(invite, 'max_attempts')
        let state = string(invite, 'state')
        const reservationExpiresAt = optionalNumber(invite, 'reservation_expires_at')
        if (expiresAt <= now) state = 'expired'
        else if (state === 'reserved' && (reservationExpiresAt ?? 0) <= now) {
          await transaction.query(
            `UPDATE relay_invites SET state = ?, reservation_id = NULL,
             reservation_expires_at = NULL, cooldown_until = ?, updated_at = ?
             WHERE token_hash = ?`,
            [
              'cooldown',
              now + RELAY_PROTOCOL_LIMITS.inviteAttemptCooldownMs,
              now,
              tokenHash
            ]
          )
          return null
        }
        const cooldownUntil = optionalNumber(invite, 'cooldown_until') ?? 0
        if (
          (state !== 'available' && !(state === 'cooldown' && cooldownUntil <= now)) ||
          attempts >= maxAttempts
        ) {
          return null
        }
        const leaseExpiresAt = Math.min(
          expiresAt,
          now + RELAY_PROTOCOL_LIMITS.inviteReservationLeaseMs
        )
        await transaction.query(
          `UPDATE relay_invites SET state = ?, attempt_count = ?, reservation_id = ?,
           reservation_expires_at = ?, cooldown_until = NULL, updated_at = ?
           WHERE token_hash = ?`,
          ['reserved', attempts + 1, reservationId, leaseExpiresAt, now, tokenHash]
        )
        return {
          userId: string(invite, 'user_id'),
          relayHostId,
          relayDeviceId: string(invite, 'relay_device_id'),
          credentialKind: 'invite',
          tokenHash,
          reservationId,
          leaseExpiresAt
        }
      }

      const deviceRows = await transaction.query(
        `SELECT * FROM relay_devices
         WHERE relay_host_id = ? AND (current_hash = ? OR grace_hash = ?)`,
        [relayHostId, tokenHash, tokenHash]
      )
      const device = deviceRows[0]
      if (!device || optionalNumber(device, 'revoked_at') !== undefined) return null
      const currentHash = string(device, 'current_hash')
      const currentExpiresAt = number(device, 'current_expires_at')
      const graceHash = device.grace_hash
      const graceExpiresAt = optionalNumber(device, 'grace_expires_at')
      let acceptedAs: 'current' | 'grace'
      let acceptedCredentialVersion: number
      if (equalHash(currentHash, tokenHash) && currentExpiresAt > now) {
        acceptedAs = 'current'
        acceptedCredentialVersion = number(device, 'current_version')
      } else if (
        typeof graceHash === 'string' &&
        equalHash(graceHash, tokenHash) &&
        (graceExpiresAt ?? 0) > now
      ) {
        acceptedAs = 'grace'
        acceptedCredentialVersion = number(device, 'grace_version')
      } else {
        return null
      }
      return {
        userId: string(device, 'user_id'),
        relayHostId,
        relayDeviceId: string(device, 'relay_device_id'),
        credentialKind: 'resume',
        tokenHash,
        reservationId,
        leaseExpiresAt: now + RELAY_PROTOCOL_LIMITS.hostAttachDeadlineMs,
        acceptedCredentialVersion,
        acceptedAs,
        resumeExpiresAt: currentExpiresAt,
        graceExpiresAt
      }
    })
  }

  async recordConnectionBasis(input: CredentialReservation & {
    basisConnId: string
    owningControlGeneration: number
    deadline: number
  }): Promise<void> {
    const now = this.now()
    await this.database.query(
      `INSERT INTO relay_connection_bases
       (basis_conn_id, user_id, relay_host_id, relay_device_id, owning_control_generation,
        credential_kind, invite_token_hash, accepted_credential_version, accepted_as,
        deadline, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.basisConnId, input.userId, input.relayHostId, input.relayDeviceId,
        input.owningControlGeneration, input.credentialKind,
        input.credentialKind === 'invite' ? input.tokenHash : null,
        input.acceptedCredentialVersion, input.acceptedAs, input.deadline, 1, now
      ]
    )
  }

  async failReservation(reservation: CredentialReservation): Promise<void> {
    if (reservation.credentialKind !== 'invite') return
    const now = this.now()
    await this.database.transaction(async (transaction) => {
      const rows = await transaction.query(
        `SELECT attempt_count, max_attempts FROM relay_invites
         WHERE token_hash = ? AND reservation_id = ? AND state = ?`,
        [reservation.tokenHash, reservation.reservationId, 'reserved']
      )
      const invite = rows[0]
      if (!invite) return
      const exhausted = number(invite, 'attempt_count') >= number(invite, 'max_attempts')
      await transaction.query(
        `UPDATE relay_invites SET state = ?, reservation_id = NULL,
         reservation_expires_at = NULL, cooldown_until = ?, updated_at = ?
         WHERE token_hash = ? AND reservation_id = ?`,
        [
          exhausted ? 'invalidated' : 'cooldown',
          exhausted ? null : now + RELAY_PROTOCOL_LIMITS.inviteAttemptCooldownMs,
          now,
          reservation.tokenHash,
          reservation.reservationId
        ]
      )
    })
  }

  async recordDirectAuthorization(input: RelayIdentity & {
    relayDeviceId: string
    directAuthId: string
    owningControlGeneration: number
    deadline: number
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO relay_direct_authorizations
       (direct_auth_id, user_id, relay_host_id, relay_device_id,
        owning_control_generation, deadline)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.directAuthId, input.userId, input.relayHostId, input.relayDeviceId,
        input.owningControlGeneration, input.deadline
      ]
    )
  }

  async installCredential(input: InstallInput): Promise<DeviceCredentialInstalled> {
    let lastError: unknown
    for (let attempt = 0; attempt <= 3; attempt++) {
      try {
        return await this.installCredentialOnce(input)
      } catch (error) {
        if (error instanceof RelayStoreError) throw error
        const committed = await this.installStatus(input)
        if (committed) return committed
        const code = (error as { code?: unknown }).code
        const retryable = ['23505', '40P01', '55P03', '40001'].includes(String(code))
        if (!retryable || attempt === 3) throw error
        lastError = error
      }
    }
    throw lastError
  }

  private async installCredentialOnce(input: InstallInput): Promise<DeviceCredentialInstalled> {
    return await this.database.transaction(async (transaction) => {
      const existing = await this.installStatusWith(transaction, input)
      if (existing) return existing
      const now = this.now()
      const basisInviteHash = await this.validateInstallAuthorization(transaction, input, now)
      const devices = await transaction.query(
        `SELECT * FROM relay_devices
         WHERE user_id = ? AND relay_host_id = ? AND relay_device_id = ?`,
        [input.userId, input.relayHostId, input.relayDeviceId]
      )
      const current = devices[0]
      if (input.expectedCurrentHash) {
        if (!current || !equalHash(string(current, 'current_hash'), input.expectedCurrentHash)) {
          throw new RelayStoreError('current_hash_mismatch')
        }
      }
      const currentVersion = current ? number(current, 'current_version') + 1 : 1
      const resumeExpiresAt = now + RELAY_PROTOCOL_LIMITS.resumeTtlMs
      const graceExpiresAt = current ? now + CREDENTIAL_GRACE_MS : undefined
      await transaction.query(
        `INSERT INTO relay_devices
         (user_id, relay_host_id, relay_device_id, current_hash, current_version,
          current_expires_at, grace_hash, grace_version, grace_expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, relay_host_id, relay_device_id) DO UPDATE SET
          current_hash = excluded.current_hash,
          current_version = excluded.current_version,
          current_expires_at = excluded.current_expires_at,
          grace_hash = excluded.grace_hash,
          grace_version = excluded.grace_version,
          grace_expires_at = excluded.grace_expires_at,
          revoked_at = NULL,
          updated_at = excluded.updated_at`,
        [
          input.userId, input.relayHostId, input.relayDeviceId, input.newResumeTokenHash,
          currentVersion, resumeExpiresAt, current ? string(current, 'current_hash') : null,
          current ? number(current, 'current_version') : null, graceExpiresAt, now
        ]
      )
      if (basisInviteHash) {
        await transaction.query(
          `UPDATE relay_invites SET state = ?, reservation_id = NULL,
           reservation_expires_at = NULL, updated_at = ? WHERE token_hash = ?`,
          ['consumed', now, basisInviteHash]
        )
      } else {
        await transaction.query(
          `UPDATE relay_invites SET state = ?, reservation_id = NULL,
           reservation_expires_at = NULL, updated_at = ?
           WHERE user_id = ? AND relay_host_id = ? AND relay_device_id = ?
             AND state IN (?, ?, ?)`,
          [
            'invalidated', now, input.userId, input.relayHostId, input.relayDeviceId,
            'available', 'reserved', 'cooldown'
          ]
        )
      }
      await transaction.query(
        `UPDATE relay_direct_authorizations SET consumed_at = ?
         WHERE user_id = ? AND relay_host_id = ? AND relay_device_id = ?
           AND consumed_at IS NULL`,
        [now, input.userId, input.relayHostId, input.relayDeviceId]
      )
      const result: DeviceCredentialInstalled = {
        v: 1,
        reqId: input.reqId,
        authorizationMode: input.authorization.mode,
        currentVersion,
        resumeExpiresAt,
        ...(graceExpiresAt === undefined ? {} : { graceExpiresAt })
      }
      await transaction.query(
        `INSERT INTO relay_install_results
         (user_id, relay_host_id, relay_device_id, req_id, authorization_mode,
          result_json, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          input.userId, input.relayHostId, input.relayDeviceId, input.reqId,
          input.authorization.mode, JSON.stringify(result), now
        ]
      )
      await this.auditWith(transaction, {
        type: 'credential-installed',
        userId: input.userId,
        relayHostId: input.relayHostId,
        relayDeviceId: input.relayDeviceId,
        detail: { reqId: input.reqId, authorizationMode: input.authorization.mode, currentVersion }
      })
      return result
    })
  }

  async installStatus(input: RelayIdentity & {
    relayDeviceId: string
    reqId: string
  }): Promise<DeviceCredentialInstalled | null> {
    return await this.installStatusWith(this.database, input)
  }

  async confirmResume(input: RelayIdentity & {
    reqId: string
    basisConnId: string
    owningControlGeneration: number
  }): Promise<DeviceResumeConfirmed> {
    return await this.database.transaction(async (transaction) => {
      const prior = await transaction.query(
        `SELECT basis_conn_id, result_json FROM relay_confirm_results
         WHERE user_id = ? AND relay_host_id = ? AND req_id = ?`,
        [input.userId, input.relayHostId, input.reqId]
      )
      if (prior[0]) {
        if (string(prior[0], 'basis_conn_id') !== input.basisConnId) {
          throw new RelayStoreError('confirmation_tuple_mismatch')
        }
        return JSON.parse(string(prior[0], 'result_json')) as DeviceResumeConfirmed
      }
      const rows = await transaction.query(
        `SELECT * FROM relay_connection_bases WHERE basis_conn_id = ?`,
        [input.basisConnId]
      )
      const basis = rows[0]
      const now = this.now()
      if (
        !basis ||
        string(basis, 'user_id') !== input.userId ||
        string(basis, 'relay_host_id') !== input.relayHostId ||
        string(basis, 'credential_kind') !== 'resume' ||
        number(basis, 'owning_control_generation') !== input.owningControlGeneration ||
        number(basis, 'active') !== 1 ||
        number(basis, 'deadline') < now
      ) {
        throw new RelayStoreError('confirmation_not_active')
      }
      const relayDeviceId = string(basis, 'relay_device_id')
      await transaction.query(
        `UPDATE relay_devices SET updated_at = updated_at
         WHERE user_id = ? AND relay_host_id = ? AND relay_device_id = ?`,
        [input.userId, input.relayHostId, relayDeviceId]
      )
      const devices = await transaction.query(
        `SELECT * FROM relay_devices
         WHERE user_id = ? AND relay_host_id = ? AND relay_device_id = ?`,
        [input.userId, input.relayHostId, relayDeviceId]
      )
      const device = devices[0]
      if (!device) throw new RelayStoreError('credential_not_found')
      const acceptedVersion = number(basis, 'accepted_credential_version')
      const decision = decideResumeCommit(
        {
          currentVersion: number(device, 'current_version'),
          currentHash: string(device, 'current_hash'),
          currentExpiresAt: number(device, 'current_expires_at'),
          graceVersion: optionalNumber(device, 'grace_version'),
          graceHash: typeof device.grace_hash === 'string' ? device.grace_hash : undefined,
          graceExpiresAt: optionalNumber(device, 'grace_expires_at'),
          revokedAt: optionalNumber(device, 'revoked_at')
        },
        acceptedVersion,
        now
      )
      if (decision.startsWith('reject-')) throw new RelayStoreError(decision)
      const renewed = decision === 'renew-current'
      const resumeExpiresAt = renewed
        ? now + RELAY_PROTOCOL_LIMITS.resumeTtlMs
        : number(device, 'current_expires_at')
      if (renewed) {
        await transaction.query(
          `UPDATE relay_devices SET current_expires_at = ?, updated_at = ?
           WHERE user_id = ? AND relay_host_id = ? AND relay_device_id = ?`,
          [resumeExpiresAt, now, input.userId, input.relayHostId, relayDeviceId]
        )
      }
      const result: DeviceResumeConfirmed = {
        v: 1,
        reqId: input.reqId,
        currentVersion: number(device, 'current_version'),
        acceptedAs: string(basis, 'accepted_as') as 'current' | 'grace',
        renewed,
        resumeExpiresAt,
        ...(optionalNumber(device, 'grace_expires_at') === undefined
          ? {}
          : { graceExpiresAt: optionalNumber(device, 'grace_expires_at') })
      }
      await transaction.query(
        `INSERT INTO relay_confirm_results
         (user_id, relay_host_id, req_id, basis_conn_id, tuple_json, result_json, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          input.userId, input.relayHostId, input.reqId, input.basisConnId,
          JSON.stringify({
            relayDeviceId,
            acceptedCredentialVersion: acceptedVersion,
            acceptedAs: result.acceptedAs,
            confirmDeadline: number(basis, 'deadline'),
            owningControlGeneration: input.owningControlGeneration
          }),
          JSON.stringify(result),
          now
        ]
      )
      await this.auditWith(transaction, {
        type: 'resume-confirmed',
        userId: input.userId,
        relayHostId: input.relayHostId,
        relayDeviceId,
        detail: { reqId: input.reqId, basisConnId: input.basisConnId, renewed }
      })
      return result
    })
  }

  async deactivateBasis(basisConnId: string): Promise<void> {
    await this.database.query(`UPDATE relay_connection_bases SET active = ? WHERE basis_conn_id = ?`, [
      0,
      basisConnId
    ])
  }

  async revoke(identity: RelayIdentity, relayDeviceId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const now = this.now()
      await transaction.query(
        `UPDATE relay_devices SET revoked_at = ?, updated_at = ?
         WHERE user_id = ? AND relay_host_id = ? AND relay_device_id = ?`,
        [now, now, identity.userId, identity.relayHostId, relayDeviceId]
      )
      await transaction.query(
        `UPDATE relay_invites SET state = ?, updated_at = ?
         WHERE user_id = ? AND relay_host_id = ? AND relay_device_id = ?`,
        ['invalidated', now, identity.userId, identity.relayHostId, relayDeviceId]
      )
      await this.auditWith(transaction, {
        type: 'device-revoked',
        ...identity,
        relayDeviceId,
        detail: {}
      })
    })
  }

  async resolveResume(
    relayHostId: string,
    token: string
  ): Promise<{ userId: string; relayDeviceId: string } | null> {
    const tokenHash = hashCredential(token)
    const rows = await this.database.query(
      `SELECT * FROM relay_devices
       WHERE relay_host_id = ? AND (current_hash = ? OR grace_hash = ?)`,
      [relayHostId, tokenHash, tokenHash]
    )
    const device = rows[0]
    if (!device || optionalNumber(device, 'revoked_at') !== undefined) return null
    const now = this.now()
    const currentValid =
      equalHash(string(device, 'current_hash'), tokenHash) &&
      number(device, 'current_expires_at') > now
    const graceHash = device.grace_hash
    const graceValid =
      typeof graceHash === 'string' &&
      equalHash(graceHash, tokenHash) &&
      (optionalNumber(device, 'grace_expires_at') ?? 0) > now
    return currentValid || graceValid
      ? { userId: string(device, 'user_id'), relayDeviceId: string(device, 'relay_device_id') }
      : null
  }

  async validateInviteForMove(relayHostId: string, token: string): Promise<boolean> {
    return Boolean(await this.resolveInviteForMove(relayHostId, token))
  }

  async resolveInviteForMove(
    relayHostId: string,
    token: string
  ): Promise<{ userId: string; relayDeviceId: string } | null> {
    const tokenHash = hashCredential(token)
    const rows = await this.database.query(
      `SELECT user_id, relay_device_id, token_hash, state, attempt_count, max_attempts, expires_at
       FROM relay_invites WHERE relay_host_id = ? AND token_hash = ?`,
      [relayHostId, tokenHash]
    )
    const invite = rows[0]
    const valid = Boolean(
      invite &&
        equalHash(string(invite, 'token_hash'), tokenHash) &&
        ['available', 'reserved', 'cooldown'].includes(string(invite, 'state')) &&
        number(invite, 'attempt_count') < number(invite, 'max_attempts') &&
        number(invite, 'expires_at') > this.now()
    )
    return valid && invite
      ? { userId: string(invite, 'user_id'), relayDeviceId: string(invite, 'relay_device_id') }
      : null
  }

  async consumeRate(input: {
    scopeKey: string
    kind: string
    limit: number
    windowMs: number
  }): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await this.consumeRateWith(
        transaction,
        input.scopeKey,
        input.kind,
        input.limit,
        input.windowMs,
        this.now()
      )
    })
  }

  async cleanup(): Promise<void> {
    const now = this.now()
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `UPDATE relay_invites SET state = ?, reservation_id = NULL,
         reservation_expires_at = NULL, updated_at = ?
         WHERE expires_at <= ? AND state IN (?, ?, ?)`,
        ['expired', now, now, 'available', 'reserved', 'cooldown']
      )
      await transaction.query(
        `UPDATE relay_invites SET state = ?, reservation_id = NULL,
         reservation_expires_at = NULL, cooldown_until = ?, updated_at = ?
         WHERE state = ? AND reservation_expires_at <= ? AND expires_at > ?`,
        ['cooldown', now + RELAY_PROTOCOL_LIMITS.inviteAttemptCooldownMs, now, 'reserved', now, now]
      )
      await transaction.query(
        `UPDATE relay_connection_bases SET active = ? WHERE active = ? AND deadline <= ?`,
        [0, 1, now]
      )
      await transaction.query(
        `UPDATE relay_direct_authorizations SET consumed_at = ?
         WHERE consumed_at IS NULL AND deadline <= ?`,
        [now, now]
      )
      await transaction.query(
        `DELETE FROM relay_rate_windows WHERE window_started_at < ?`,
        [now - 24 * 60 * 60 * 1000]
      )
    })
  }

  private async installStatusWith(
    database: RelayDatabase,
    input: RelayIdentity & { relayDeviceId: string; reqId: string }
  ): Promise<DeviceCredentialInstalled | null> {
    const rows = await database.query(
      `SELECT result_json FROM relay_install_results
       WHERE user_id = ? AND relay_host_id = ? AND relay_device_id = ? AND req_id = ?`,
      [input.userId, input.relayHostId, input.relayDeviceId, input.reqId]
    )
    return rows[0] ? (JSON.parse(string(rows[0], 'result_json')) as DeviceCredentialInstalled) : null
  }

  private async validateInstallAuthorization(
    transaction: RelayDatabase,
    input: InstallInput,
    now: number
  ): Promise<string | null> {
    if (input.authorization.mode === 'relay-basis') {
      const rows = await transaction.query(
        `SELECT * FROM relay_connection_bases WHERE basis_conn_id = ?`,
        [input.authorization.basisConnId]
      )
      const basis = rows[0]
      if (
        !basis ||
        string(basis, 'user_id') !== input.userId ||
        string(basis, 'relay_host_id') !== input.relayHostId ||
        string(basis, 'relay_device_id') !== input.relayDeviceId ||
        string(basis, 'credential_kind') !== 'invite' ||
        number(basis, 'owning_control_generation') !== input.owningControlGeneration ||
        number(basis, 'active') !== 1 ||
        number(basis, 'deadline') < now
      ) {
        throw new RelayStoreError('invalid_relay_basis')
      }
      return string(basis, 'invite_token_hash')
    }
    const rows = await transaction.query(
      `SELECT * FROM relay_direct_authorizations WHERE direct_auth_id = ?`,
      [input.authorization.directAuthId]
    )
    const direct = rows[0]
    if (
      !direct ||
      string(direct, 'user_id') !== input.userId ||
      string(direct, 'relay_host_id') !== input.relayHostId ||
      string(direct, 'relay_device_id') !== input.relayDeviceId ||
      number(direct, 'owning_control_generation') !== input.owningControlGeneration ||
      number(direct, 'deadline') < now ||
      optionalNumber(direct, 'consumed_at') !== undefined
    ) {
      throw new RelayStoreError('invalid_direct_authorization')
    }
    await transaction.query(
      `UPDATE relay_direct_authorizations SET consumed_at = ? WHERE direct_auth_id = ?`,
      [now, input.authorization.directAuthId]
    )
    return null
  }

  private async consumeRateWith(
    transaction: RelayDatabase,
    scopeKey: string,
    kind: string,
    limit: number,
    windowMs: number,
    now: number
  ): Promise<void> {
    const windowStartedAt = Math.floor(now / windowMs) * windowMs
    const rows = await transaction.query(
      `INSERT INTO relay_rate_windows
       (scope_key, window_kind, window_started_at, count) VALUES (?, ?, ?, ?)
       ON CONFLICT (scope_key, window_kind, window_started_at) DO UPDATE
       SET count = relay_rate_windows.count + 1 RETURNING count`,
      [scopeKey, kind, windowStartedAt, 1]
    )
    if (number(rows[0]!, 'count') > limit) throw new RelayStoreError('rate_limit_exceeded')
  }

  private async auditWith(
    transaction: RelayDatabase,
    event: RelayIdentity & {
      type: string
      relayDeviceId?: string
      detail: Record<string, unknown>
    }
  ): Promise<void> {
    await transaction.query(
      `INSERT INTO relay_audit_events
       (id, at, type, user_id, relay_host_id, relay_device_id, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(), this.now(), event.type, event.userId, event.relayHostId,
        event.relayDeviceId, JSON.stringify(event.detail)
      ]
    )
  }
}
