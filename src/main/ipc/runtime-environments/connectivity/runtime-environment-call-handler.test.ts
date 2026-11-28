import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
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

beforeEach(() => {
  registerRuntimeEnvironmentPassiveHandlers(() => '/user-data')
})

afterEach(() => {
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
