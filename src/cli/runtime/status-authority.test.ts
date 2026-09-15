import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getCliStatus } from './status'
import { RuntimeClient } from './client'
import { tryReadMetadata } from './metadata'
import { sendRequest } from './transport'
import { launchOrcaApp } from './launch'
import { RuntimeClientError } from './types'

vi.mock('./metadata', () => ({
  tryReadMetadata: vi.fn(),
  getDefaultUserDataPath: vi.fn()
}))
vi.mock('./runtime-remote-pairing', () => ({
  resolveRemotePairing: () => null
}))
vi.mock('./transport', () => ({ sendRequest: vi.fn() }))
vi.mock('./launch', () => ({ launchOrcaApp: vi.fn() }))
const metadata = {
  runtimeId: 'cached',
  pid: 123456,
  startedAt: 1,
  authToken: 'fixture',
  transports: [{ kind: 'unix' as const, endpoint: 'fixture' }]
}
const ready = {
  runtimeId: 'cached',
  graphStatus: 'ready',
  authoritativeWindowId: 1
}
const success = (result: unknown) => ({
  id: 'fixture',
  ok: true as const,
  result,
  _meta: { runtimeId: 'cached' }
})
beforeEach(() => {
  vi.mocked(tryReadMetadata).mockReturnValue(metadata)
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('fixture'), { code: 'ESRCH' })
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
})

it.each([
  { outcome: 'identity_changed' },
  { outcome: 'invalid_response' },
  { outcome: 'closed' },
  { outcome: 'timeout' },
  { outcome: 'socket_error', code: 'EPERM', connected: false },
  { outcome: 'socket_error', code: 'EACCES', connected: false },
  { outcome: 'socket_error', code: 'ECONNREFUSED', connected: true },
  { outcome: 'socket_error', code: 'ENOENT' }
])(
  'cached exit cannot override failed observation %j or authorize launch',
  async (transportFailure) => {
    vi.mocked(sendRequest).mockRejectedValue(
      new RuntimeClientError('runtime_unavailable', 'fixture', {
        transportFailure
      })
    )
    await expect(new RuntimeClient('fixture', 100, null, null).openOrca(500)).rejects.toMatchObject(
      {
        data: {
          statusObservation: { process: 'exited', runtime: 'unverifiable' },
          transportFailure
        }
      }
    )
    expect(launchOrcaApp).not.toHaveBeenCalled()
  }
)
it('cached exit cannot override authenticated RPC denial', async () => {
  vi.mocked(sendRequest).mockResolvedValue({
    id: 'fixture',
    ok: false,
    error: { code: 'permission_denied', message: 'fixture' },
    _meta: { runtimeId: 'cached' }
  })
  await expect(new RuntimeClient('fixture', 100, null, null).openOrca(500)).rejects.toMatchObject({
    code: 'permission_denied'
  })
  expect(launchOrcaApp).not.toHaveBeenCalled()
})
it.each([
  {},
  null,
  [],
  true,
  '',
  { ...ready, graphStatus: 'starting' },
  { ...ready, authoritativeWindowId: '1' },
  { ...ready, desktopWindowStatus: 'bogus' },
  { ...ready, capabilities: {} },
  { ...ready, degradations: [{}] },
  { ...ready, runtimeId: '' }
])('malformed result %j cannot become reachable success or authorize launch', async (result) => {
  vi.mocked(sendRequest).mockResolvedValue(success(result))
  await expect(new RuntimeClient('fixture', 100, null, null).openOrca(500)).rejects.toMatchObject({
    code: 'invalid_runtime_response'
  })
  expect(launchOrcaApp).not.toHaveBeenCalled()
})
it('binds result identity to discovery even with a matching envelope', async () => {
  vi.mocked(sendRequest).mockResolvedValue(success({ ...ready, runtimeId: 'replacement' }))
  await expect(getCliStatus('fixture')).rejects.toMatchObject({
    data: { transportFailure: { outcome: 'identity_changed' } }
  })
})
it('valid older status and unknown additive fields outrank cached PID exit', async () => {
  vi.mocked(sendRequest).mockResolvedValue(
    success({ ...ready, futureField: true, capabilities: ['future.v1'] })
  )
  expect((await getCliStatus('fixture')).result).toMatchObject({
    app: { running: true, desktopWindowStatus: 'available' },
    runtime: { state: 'ready', capabilities: ['future.v1'] }
  })
  expect(process.kill).not.toHaveBeenCalled()
})
it.each(['ENOENT', 'ECONNREFUSED'])(
  'absent endpoint %s plus cached exit permits one fresh launch',
  async (code) => {
    vi.useFakeTimers()
    vi.mocked(sendRequest)
      .mockRejectedValueOnce(
        new RuntimeClientError('runtime_unavailable', 'fixture', {
          transportFailure: { outcome: 'socket_error', code, connected: false }
        })
      )
      .mockResolvedValue(success(ready))
    const pending = new RuntimeClient('fixture', 100, null, null).openOrca(500)
    await vi.runAllTimersAsync()
    expect((await pending).result.runtime.state).toBe('ready')
    expect(launchOrcaApp).toHaveBeenCalledOnce()
  }
)
