import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  environment: vi.fn(),
  context: vi.fn(),
  queue: vi.fn(),
  tunnel: vi.fn(),
  cancel: vi.fn(),
  rpc: vi.fn()
}))
vi.mock('./orcad-managed-runtime-context', () => ({
  requireManagedOrcadEnvironment: mocks.environment,
  resolveLinkedOrcadContext: mocks.context
}))
vi.mock('../ipc/ssh-target-lifecycle-queue', () => ({ runTargetLifecycle: mocks.queue }))
vi.mock('./orcad-managed-tunnel', () => ({ ensureOrcadManagedTunnel: mocks.tunnel }))
vi.mock('./orcad-managed-stop-cancellation', () => ({
  cancelInterruptedOrcadManagedStop: mocks.cancel
}))
vi.mock('./orcad-decommission-client', () => ({
  requestRemoteOrcadManagedStopCancellation: mocks.rpc
}))
import { cancelManagedOrcadStop } from './orcad-runtime-stop-cancellation'
const environment = {
  id: 'environment',
  runtimeId: 'runtime',
  orcadDeployment: { sshTargetId: 'ssh-target' }
}
const context = { connection: {}, host: {}, remoteHome: '/home/host' }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.environment.mockReturnValue(environment)
  mocks.context.mockResolvedValue(context)
  mocks.queue.mockImplementation(async (_target, run) => run())
})

it.each(['none', 'pending', 'refused'] as const)(
  'does not open a pairing tunnel when cancellation preflight returns %s',
  async (outcome) => {
    const result = { outcome, code: 'preflight', reason: 'No mutation' }
    mocks.cancel.mockResolvedValue(result)
    expect(await cancelManagedOrcadStop('/desktop', { selector: 'host' })).toBe(result)
    expect(mocks.environment).toHaveBeenCalledWith('/desktop', 'host')
    expect(mocks.queue).toHaveBeenCalledWith('ssh-target', expect.any(Function))
    expect(mocks.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        conn: context.connection,
        host: context.host,
        remoteHome: '/home/host',
        runtimeId: 'runtime'
      })
    )
    expect(mocks.tunnel).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
  }
)

it('uses the original request and saved environment only after recovery preflight reaches RPC', async () => {
  const request = { authority: 'original' }
  const response = { outcome: 'canceled' }
  mocks.rpc.mockResolvedValue(response)
  mocks.cancel.mockImplementation(async (options) => options.requestCancellation(request))
  expect(await cancelManagedOrcadStop('/desktop', { selector: 'host' })).toBe(response)
  expect(mocks.tunnel).toHaveBeenCalledWith('/desktop', 'environment')
  expect(mocks.rpc).toHaveBeenCalledWith(environment, request)
  expect(mocks.tunnel.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.rpc.mock.invocationCallOrder[0]
  )
})

it('does not send cancellation when tunnel establishment fails', async () => {
  mocks.tunnel.mockRejectedValue(new Error('SSH unavailable'))
  mocks.cancel.mockImplementation(async (options) => options.requestCancellation({}))
  await expect(cancelManagedOrcadStop('/desktop', { selector: 'host' })).rejects.toThrow(
    'SSH unavailable'
  )
  expect(mocks.rpc).not.toHaveBeenCalled()
})
