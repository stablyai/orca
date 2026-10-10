import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DeviceRegistry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'
import { collectRemoteServerStatus } from './remote-server-status'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, existsSync: vi.fn(actual.existsSync), statSync: vi.fn(actual.statSync) }
})

const paths: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const path of paths.splice(0)) {
    fs.rmSync(path, { recursive: true, force: true })
  }
})
function profile(): string {
  const path = fs.mkdtempSync(join(tmpdir(), 'orca-status-registry-'))
  paths.push(path)
  return path
}
const listener = { state: 'not_listening' } as const

it('projects only allowed grant fields, deduplicates transports and never infers connections from lastSeenAt', () => {
  const path = profile()
  const device = {
    deviceId: 'test-phone',
    name: '\x1b]52;c;ignored\x07Phone\n\x1b[31m',
    scope: 'mobile',
    token: 'SECRET-TOKEN',
    pairedAt: 123,
    lastSeenAt: 456,
    relayBinding: {
      relayHostId: 'SECRET-RELAY',
      relayDeviceId: 'test-phone',
      ownerIdentityKey: 'SECRET-OWNER-KEY'
    },
    pushRegistration: { registrationId: 'SECRET-PUSH', filter: {}, expiresAt: 999 }
  }
  fs.writeFileSync(join(path, DEVICE_REGISTRY_FILENAME), JSON.stringify([device]))
  const registry = new DeviceRegistry(path)
  const connections: { deviceId: string; scope: 'mobile'; transport: 'direct' | 'relay' }[] = [
    { deviceId: 'test-phone', scope: 'mobile', transport: 'direct' },
    { deviceId: 'test-phone', scope: 'mobile', transport: 'relay' }
  ]
  const wiring = { getAuthenticatedConnections: () => connections }
  const status = collectRemoteServerStatus(listener, registry, wiring)
  expect(status).toEqual({
    listener,
    grants: {
      state: 'available',
      total: 1,
      pending: 0,
      byScope: { runtime: 0, mobile: 1 },
      truncated: false,
      entries: [
        { deviceId: 'test-phone', name: 'Phone', scope: 'mobile', createdAt: 123, lastSeenAt: 456 }
      ]
    },
    connectedClients: {
      state: 'available',
      count: 1,
      connectionCount: 2,
      byScope: { runtime: 0, mobile: 1 },
      truncated: false,
      entries: [
        {
          deviceId: 'test-phone',
          name: 'Phone',
          scope: 'mobile',
          connectionCount: 2,
          transports: { direct: 1, relay: 1 }
        }
      ]
    }
  })
  for (const secret of ['SECRET-TOKEN', 'SECRET-RELAY', 'SECRET-OWNER-KEY', 'SECRET-PUSH']) {
    expect(JSON.stringify(status)).not.toContain(secret)
  }
  if (status.grants.state !== 'available') {
    throw new Error('Missing grants')
  }
  status.grants.entries[0]!.name = 'Changed copy'
  expect(registry.listDevices()[0]?.name).toBe(device.name)
  connections.length = 0
  expect(collectRemoteServerStatus(listener, registry, wiring).connectedClients).toMatchObject({
    count: 0,
    connectionCount: 0
  })
  connections.push({ deviceId: 'test-phone', scope: 'mobile', transport: 'direct' })
  registry.removeDevice('test-phone')
  expect(collectRemoteServerStatus(listener, registry, wiring).connectedClients).toMatchObject({
    count: 0,
    connectionCount: 0
  })
})

it('distinguishes a missing registry from malformed and inaccessible registries without rewriting them', () => {
  const path = profile()
  const file = join(path, DEVICE_REGISTRY_FILENAME)
  const wiring = { getAuthenticatedConnections: () => [] }
  expect(
    collectRemoteServerStatus(listener, new DeviceRegistry(path), wiring).grants
  ).toMatchObject({ state: 'available', total: 0 })
  for (const contents of ['{broken', '{}', '[null]', '[{"deviceId":"invalid"}]']) {
    fs.writeFileSync(file, contents)
    expect(collectRemoteServerStatus(listener, new DeviceRegistry(path), wiring).grants).toEqual({
      state: 'unavailable'
    })
    expect(fs.readFileSync(file, 'utf8')).toBe(contents)
  }
  const original = fs.statSync
  vi.spyOn(fs, 'existsSync').mockImplementation((candidate) => candidate !== file)
  vi.spyOn(fs, 'statSync').mockImplementation((...args) => {
    if (args[0] === file) {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    }
    return original(...args)
  })
  expect(collectRemoteServerStatus(listener, new DeviceRegistry(path), wiring).grants).toEqual({
    state: 'unavailable'
  })
})

it.each(['missing token', 'empty token', 'duplicate identity'])(
  'reports an unavailable inventory for a registry with %s',
  (invalid) => {
    const path = profile()
    const file = join(path, DEVICE_REGISTRY_FILENAME)
    const device = {
      deviceId: 'test-client',
      name: 'Client A',
      scope: 'runtime',
      token: invalid === 'missing token' ? undefined : invalid === 'empty token' ? '' : 'token-a',
      pairedAt: 1,
      lastSeenAt: 2
    }
    const devices = [device]
    if (invalid === 'duplicate identity') {
      devices.push({ ...device, name: 'Client B', token: 'token-b' })
    }
    const contents = JSON.stringify(devices)
    fs.writeFileSync(file, contents)
    const registry = new DeviceRegistry(path)
    const getAuthenticatedConnections = vi.fn(() => [
      { deviceId: device.deviceId, scope: 'runtime' as const, transport: 'direct' as const }
    ])

    expect(collectRemoteServerStatus(listener, registry, { getAuthenticatedConnections })).toEqual({
      listener,
      grants: { state: 'unavailable' },
      connectedClients: { state: 'unavailable' }
    })
    expect(getAuthenticatedConnections).not.toHaveBeenCalled()
    expect(fs.readFileSync(file, 'utf8')).toBe(contents)
  }
)

it('bounds returned detail while retaining exact totals, and does not manufacture zeros for absent providers', () => {
  expect(collectRemoteServerStatus({ state: 'disabled' }, null, null)).toEqual({
    listener: { state: 'disabled' },
    grants: { state: 'unavailable' },
    connectedClients: { state: 'unavailable' }
  })
  const path = profile()
  fs.writeFileSync(
    join(path, DEVICE_REGISTRY_FILENAME),
    JSON.stringify(
      Array.from({ length: 105 }, (_, i) => ({
        deviceId: `test-${i}`,
        name: 'a'.repeat(300),
        scope: 'runtime',
        token: `secret-${i}`,
        pairedAt: 1,
        lastSeenAt: 0
      }))
    )
  )
  const registry = new DeviceRegistry(path)
  const snapshot = collectRemoteServerStatus(listener, registry, {
    getAuthenticatedConnections: () => []
  })
  expect(snapshot.grants).toMatchObject({
    state: 'available',
    total: 105,
    pending: 105,
    truncated: true
  })
  if (snapshot.grants.state !== 'available') {
    throw new Error('Missing grants')
  }
  expect(snapshot.grants.entries).toHaveLength(100)
  expect(snapshot.grants.entries[0]?.name).toHaveLength(160)
  const connected = collectRemoteServerStatus(listener, registry, {
    getAuthenticatedConnections: () =>
      registry.listDevices().map((device) => ({
        deviceId: device.deviceId,
        scope: device.scope,
        transport: 'direct' as const
      }))
  }).connectedClients
  expect(connected).toMatchObject({
    state: 'available',
    count: 105,
    connectionCount: 105,
    truncated: true
  })
  if (connected.state !== 'available') {
    throw new Error('Missing clients')
  }
  expect(connected.entries).toHaveLength(100)
  expect(collectRemoteServerStatus(listener, registry, null).connectedClients).toEqual({
    state: 'unavailable'
  })
})
