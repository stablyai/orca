import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RemoteRuntimeClientError } from '../../../../shared/remote-runtime/remote-runtime-client-error'
import { RuntimeRpcCallQueueOverloadError } from '../../../../shared/remote-runtime/rpc/runtime-rpc-call-queue'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import {
  clearRuntimeEnvironmentManualDisconnect,
  markRuntimeEnvironmentManuallyDisconnected
} from './runtime-environment-manual-disconnect'
import { callRuntimeEnvironment } from '../requests/runtime-environment-transport-routing'
import { registerRuntimeEnvironmentPassiveHandlers } from './runtime-environment-connectivity-handlers'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  }
}))
vi.mock('../../browser/desktop-browser-bridge-reconcile', () => ({
  requestDesktopBrowserBridgeReconcile: vi.fn(),
  resetDesktopBrowserBridgeEnvironment: vi.fn()
}))
vi.mock('../../../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  resolveEnvironment: vi.fn(async (_path: string, selector: string) => ({
    id: selector,
    runtimeId: 'runtime_m4'
  })),
  addEnvironmentFromPairingCode: vi.fn(),
  listEnvironments: vi.fn()
}))
vi.mock('../../../runtime/client/navigation/desktop-chat-creation-history', () => ({
  desktopChatCreationHistory: () => ({ recordCreate: vi.fn(async () => undefined) })
}))
vi.mock('../../../wsl/orcad/wsl-orcad-account-env', () => ({
  withWslOrcadAccountEnv: vi.fn(async ({ params }: { params: unknown }) => ({ ok: true, params }))
}))
vi.mock('../requests/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: vi.fn()
}))

const ENV = 'env_m4'
const stop = { method: 'orchestration.workerStop', params: { dispatch: 'ctx_remote000001' } }

function call(args: Record<string, unknown>): Promise<RuntimeRpcResponse<unknown>> {
  const handler = handlers.get('runtimeEnvironments:call')!
  return handler({}, { selector: ENV, ...args }) as Promise<RuntimeRpcResponse<unknown>>
}

async function failureData(error: Error): Promise<unknown> {
  vi.mocked(callRuntimeEnvironment).mockRejectedValue(error)
  const response = await call(stop)
  return response.ok ? undefined : response.error.data
}

beforeEach(() => {
  registerRuntimeEnvironmentPassiveHandlers(() => '/user-data')
})

afterEach(() => {
  clearRuntimeEnvironmentManualDisconnect(ENV)
  vi.mocked(callRuntimeEnvironment).mockReset()
  handlers.clear()
})

// The renderer's retry key reaches the paired computer's orchestration envelope.
it("puts a renderer orchestration write's request id on the paired call", async () => {
  vi.mocked(callRuntimeEnvironment).mockResolvedValue({
    id: 'rpc',
    ok: true,
    result: { state: 'stopped' },
    _meta: { runtimeId: 'runtime_m4' }
  })
  await call({ ...stop, orchestrationRequestId: 'req-1' })
  expect(vi.mocked(callRuntimeEnvironment).mock.calls[0][6]).toEqual({
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: 'req-1'
  })
})

// Before the host authenticated us nothing but the handshake went out: proven unsent.
it('marks a failure before the host answered the handshake as unsent', async () => {
  const error = new RemoteRuntimeClientError(
    'remote_runtime_unavailable',
    'Could not connect to the remote Orca runtime.',
    { pairingStage: 'connect' }
  )
  expect(await failureData(error)).toEqual({ clientMade: true, requestSent: false })
})

// The socket's own keyed-request proof (its typed flag) is kept.
it("keeps the socket's proof that a keyed request was never sent", async () => {
  const error = new RemoteRuntimeClientError('runtime_timeout', 'Timed out.', {
    pairingStage: 'runtime',
    data: { requestSent: false },
    requestUnsent: true
  })
  expect(await failureData(error)).toEqual({ clientMade: true, requestSent: false })
})

// An error's data can be a server's answer (a shared-control failure keeps it), forwarded from a
// third computer: it can't claim this Orca's proof, whatever it says.
it('never takes a delivery proof from the data of an error this Orca passes on', async () => {
  const error = new RemoteRuntimeClientError('remote_runtime_unavailable', 'C is unreachable.', {
    pairingStage: 'runtime',
    data: { server: 'C', clientMade: true, requestSent: false }
  })
  expect(await failureData(error)).toEqual({ server: 'C', clientMade: true })
})

// The paired computer answered: its data can't say this Orca made the failure, or that the stop
// never left this computer, whether it claims so itself or forwards another computer's claim.
it.each([
  ['the paired computer itself', { clientMade: true, requestSent: false }, {}],
  [
    'a third computer, forwarded',
    { server: 'C', clientMade: true, requestSent: false },
    { server: 'C' }
  ]
])("strips this Orca's provenance from an answer made by %s", async (_from, data, kept) => {
  vi.mocked(callRuntimeEnvironment).mockResolvedValue({
    id: 'rpc',
    ok: false,
    error: { code: 'remote_runtime_unavailable', message: 'Could not reach C.', data },
    _meta: { runtimeId: 'runtime_m4' }
  })
  const response = await call(stop)
  expect(response).toEqual({
    id: 'rpc',
    ok: false,
    error: { code: 'remote_runtime_unavailable', message: 'Could not reach C.', data: kept },
    _meta: { runtimeId: 'runtime_m4' }
  })
})

// After the host authenticated us the request may have gone out: no proof either way.
it('claims nothing about delivery for a timeout after the handshake', async () => {
  const error = new RemoteRuntimeClientError('runtime_timeout', 'Timed out.', {
    pairingStage: 'runtime'
  })
  expect(await failureData(error)).toEqual({ clientMade: true })
})

it('claims nothing about delivery for a full call queue', async () => {
  expect(await failureData(new RuntimeRpcCallQueueOverloadError('selector'))).toEqual({
    clientMade: true
  })
})

// Disconnected before the call: never sent. Disconnected during it: the call may have landed.
it('marks a manual disconnect as unsent only when it came before the call', async () => {
  markRuntimeEnvironmentManuallyDisconnected(ENV)
  const before = await call(stop)
  expect(before.ok ? undefined : before.error.data).toEqual({
    clientMade: true,
    requestSent: false
  })
  clearRuntimeEnvironmentManualDisconnect(ENV)

  vi.mocked(callRuntimeEnvironment).mockImplementation(async () => {
    markRuntimeEnvironmentManuallyDisconnected(ENV)
    return { id: 'rpc', ok: true, result: { state: 'stopped' }, _meta: { runtimeId: 'runtime_m4' } }
  })
  const during = await call(stop)
  expect(during.ok ? undefined : during.error.data).toEqual({ clientMade: true })
})
