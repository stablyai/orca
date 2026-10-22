import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { devicePrincipalOf } from './device-principal'
import { DeviceRegistry, type DeviceEntry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'
import type { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import type { AuthenticatedMobileSocket } from './rpc/mobile-socket-wiring'

function legacyRow(overrides: Partial<DeviceEntry> = {}): DeviceEntry {
  return {
    deviceId: 'device-1',
    name: 'Phone',
    token: 'legacy-token',
    scope: 'mobile',
    pairedAt: 1,
    lastSeenAt: 2,
    ...overrides
  }
}

function registryWith(rows: unknown[]): { registry: DeviceRegistry; path: string } {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-device-principal-'))
  const path = join(userDataPath, DEVICE_REGISTRY_FILENAME)
  writeFileSync(path, JSON.stringify(rows))
  return { registry: new DeviceRegistry(userDataPath), path }
}

function socketFor(device: DeviceEntry): AuthenticatedMobileSocket {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch only uses ws as a map key for abort registration.
    ws: {} as AuthenticatedMobileSocket['ws'],
    connectionId: 'connection-1',
    transcriptHashB64: null,
    device: { ...devicePrincipalOf(device), deviceToken: device.token },
    clientCapabilities: [],
    transport: { transport: 'direct' }
  }
}

describe('device principal', () => {
  it('keeps the legacy token as client id and sha256(token) as caller fingerprint', () => {
    expect(devicePrincipalOf(legacyRow())).toEqual({
      deviceId: 'device-1',
      scope: 'mobile',
      clientId: 'legacy-token',
      callerFingerprint: createHash('sha256').update('legacy-token').digest('hex'),
      credentialRevision: 0
    })
    expect(
      devicePrincipalOf(legacyRow({ callerFingerprint: 'carried', credentialRevision: 3 }))
    ).toMatchObject({ callerFingerprint: 'carried', credentialRevision: 3 })
  })

  it('round-trips the optional principal fields and drops malformed values on load', () => {
    const { registry, path } = registryWith([
      legacyRow(),
      legacyRow({
        deviceId: 'device-2',
        token: 't2',
        credentialRevision: 2,
        callerFingerprint: 'f'
      }),
      {
        ...legacyRow({ deviceId: 'device-3', token: 't3' }),
        credentialRevision: -1,
        callerFingerprint: 7
      }
    ])
    expect(registry.getDevice('device-1')).not.toHaveProperty(
      'credentialRevision',
      expect.anything()
    )
    expect(registry.getDevice('device-2')).toMatchObject({
      credentialRevision: 2,
      callerFingerprint: 'f'
    })
    expect(registry.getDevice('device-3')?.credentialRevision).toBeUndefined()
    expect(registry.getDevice('device-3')?.callerFingerprint).toBeUndefined()

    registry.updateLastSeen('device-2')
    const saved: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    expect(saved).toContainEqual(expect.objectContaining({ deviceId: 'device-2' }))
    expect(Array.isArray(saved) ? saved[1] : null).toMatchObject({
      token: 't2',
      credentialRevision: 2,
      callerFingerprint: 'f'
    })
  })

  it('binds an authenticated socket to its device id, revision and token', () => {
    const { registry } = registryWith([legacyRow({ credentialRevision: 1 })])
    const bound = { deviceId: 'device-1', credentialRevision: 1, deviceToken: 'legacy-token' }
    expect(registry.resolveAuthenticatedPrincipal(bound)?.deviceId).toBe('device-1')
    expect(registry.resolveAuthenticatedPrincipal({ ...bound, credentialRevision: 0 })).toBeNull()
    expect(registry.resolveAuthenticatedPrincipal({ ...bound, deviceToken: 'other' })).toBeNull()
    registry.removeDevice('device-1')
    expect(registry.resolveAuthenticatedPrincipal(bound)).toBeNull()
  })

  it('dispatches an old phone with its token as client id and refuses it once re-credentialed', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-device-principal-rpc-'))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: status.get only reads these three members.
    const runtime = {
      configureNotificationDismissalStore: () => {},
      getRuntimeId: () => 'test-runtime',
      getStatus: vi.fn().mockResolvedValue({ graphStatus: 'ok' })
    } as unknown as OrcaRuntimeService
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
    const registry = new DeviceRegistry(userDataPath)
    server['deviceRegistry'] = registry
    const phone = registry.addDevice('phone', 'mobile')
    const socket = socketFor(phone)
    const dispatch = vi.spyOn(server['dispatcher'], 'dispatchStreaming')

    const replies: string[] = []
    await server['handleWebSocketMessage'](
      JSON.stringify({ id: 'r1', method: 'status.get' }),
      (response) => replies.push(response),
      () => {},
      undefined,
      undefined,
      phone.token,
      socket
    )
    expect(dispatch.mock.calls[0]?.[2]).toMatchObject({
      clientId: phone.token,
      pairedDeviceId: phone.deviceId,
      authenticatedCallerFingerprint: createHash('sha256').update(phone.token).digest('hex')
    })

    // A credential change bumps the revision; the open socket's next request is refused.
    registry['devices'] = registry['devices'].map((row) => ({ ...row, credentialRevision: 1 }))
    await server['handleWebSocketMessage'](
      JSON.stringify({ id: 'r2', method: 'status.get' }),
      (response) => replies.push(response),
      () => {},
      undefined,
      undefined,
      phone.token,
      socket
    )
    expect(dispatch).toHaveBeenCalledOnce()
    expect(JSON.parse(replies.at(-1)!)).toMatchObject({
      id: 'r2',
      ok: false,
      error: { code: 'unauthorized' }
    })
  })
})
