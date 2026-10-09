import { beforeEach, expect, it, vi } from 'vitest'
import { createSshConnectionRoute } from './ssh-connection-route'
import { ConnectionRouteSchema } from './connection-route'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  create: vi.fn(() => 'native-id'),
  open: vi.fn(),
  close: vi.fn()
}))
vi.mock('./ssh-route-credentials', () => ({ readSshRouteCredentials: mocks.read }))
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => mocks }))

function openResult(endpoint: string) {
  return JSON.stringify({
    endpoint,
    stages: [
      { code: 'connected', message: 'SSH authenticated as user@server.example:2222' },
      { code: 'listening', message: 'SSH server will connect to localhost:6768' }
    ]
  })
}

const route = ConnectionRouteSchema.parse({
  kind: 'ssh',
  host: 'server.example',
  port: 2222,
  username: 'user',
  targetHost: 'localhost',
  targetPort: 6768,
  hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
  credentialId: 'secret-ref'
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.read.mockResolvedValue({ kind: 'password', password: 'secret' })
  mocks.open.mockResolvedValue(openResult('ws://127.0.0.1:32123'))
})

it('keeps the advertised endpoint out of the native SSH destination and forwards via the server', async () => {
  const lease = await createSshConnectionRoute(route).open(
    'ws://unreachable.example:6768',
    new AbortController().signal
  )
  expect(lease.endpoint).toBe('ws://127.0.0.1:32123')
  expect(lease.stages).toHaveLength(2)
  expect(JSON.parse(mocks.open.mock.calls[0]![1])).toEqual({
    host: route.host,
    port: 2222,
    username: 'user',
    targetHost: 'localhost',
    targetPort: 6768,
    hostKeyFingerprint: route.hostKeyFingerprint,
    password: 'secret'
  })
  lease.close()
  lease.close()
  expect(mocks.close).toHaveBeenCalledExactlyOnceWith('native-id')
})

it('sends the socket destination the SSH server will dial', async () => {
  const namedTarget = ConnectionRouteSchema.parse({
    ...route,
    targetHost: 'internal-name'
  })
  await createSshConnectionRoute(namedTarget).open(
    'ws://unreachable.example:6768',
    new AbortController().signal
  )
  expect(JSON.parse(mocks.open.mock.calls[0]![1]).targetHost).toBe('internal-name')
})

it('reads the jump credentials under the jump profile id and sends them', async () => {
  mocks.read.mockImplementation(async (id: string) =>
    id === 'jump-ref' ? { kind: 'password', password: 'jump-secret' } : { kind: 'password', password: 'secret' }
  )
  const jumpRoute = ConnectionRouteSchema.parse({
    ...route,
    jump: {
      host: 'jump.example',
      port: 22,
      username: 'jump-user',
      hostKeyFingerprint: `SHA256:${'B'.repeat(43)}`,
      credentialId: 'jump-ref'
    }
  })
  await createSshConnectionRoute(jumpRoute).open(
    'ws://unreachable.example:6768',
    new AbortController().signal
  )
  expect(JSON.parse(mocks.open.mock.calls[0]![1]).jump).toEqual({
    host: 'jump.example',
    port: 22,
    username: 'jump-user',
    hostKeyFingerprint: `SHA256:${'B'.repeat(43)}`,
    password: 'jump-secret'
  })
})

it('closes a native handshake immediately when cancelled and never returns a stale lease', async () => {
  const pending = Promise.withResolvers<string>()
  mocks.open.mockReturnValue(pending.promise)
  const controller = new AbortController()
  const promise = createSshConnectionRoute(route).open('ws://server:6768', controller.signal)
  const assertion = expect(promise).rejects.toThrow()
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledOnce())
  controller.abort()
  expect(mocks.close).toHaveBeenCalledOnce()
  pending.resolve(openResult('ws://127.0.0.1:32123'))
  await assertion
})
