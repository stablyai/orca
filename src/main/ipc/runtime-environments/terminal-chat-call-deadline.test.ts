import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as EnvironmentCatalog from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import type * as AbortableRequests from './runtime-environment-abortable-requests'

const environment = vi.hoisted(() => ({
  id: 'chat-deadline-host',
  name: 'QA',
  runtimeId: 'runtime',
  endpoints: []
}))
const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  accounts: vi.fn(),
  prepare: vi.fn(),
  send: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  addEnvironmentFromPairingCode: vi.fn(),
  listEnvironments: () => [],
  removeEnvironment: vi.fn(),
  markEnvironmentUsed: vi.fn(),
  resolveEnvironment: () => environment
}))
vi.mock('../../../shared/remote-runtime/host-catalog/runtime-environments', async (original) => ({
  ...(await original<typeof EnvironmentCatalog>()),
  getPreferredPairedRuntimeConnection: () => ({ endpoint: 'ws://127.0.0.1:1' })
}))
vi.mock('../../runtime/client/navigation/desktop-chat-creation-history', () => ({
  desktopChatCreationHistory: () => ({ recordCreate: async () => {} })
}))
vi.mock('../../wsl/orcad/wsl-orcad-account-env', () => ({ withWslOrcadAccountEnv: mocks.accounts }))
vi.mock('../../wsl/orcad/wsl-orcad-host-environments', () => ({
  observeWslOrcadHostResponse: () => {},
  wslOrcadHostSupports: () => false
}))
vi.mock('./runtime-environment-request-preparation', () => ({
  prepareFencedRuntimeRequest: mocks.prepare
}))
vi.mock('./runtime-environment-abortable-requests', async (original) => ({
  ...(await original<typeof AbortableRequests>()),
  sendRemoteRuntimeConnectionRequestAbortable: mocks.send
}))

import { registerRuntimeEnvironmentPassiveHandlers } from './runtime-environment-connectivity-handlers'

function call(params: unknown, timeoutMs = 65_000): Promise<unknown> {
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'runtimeEnvironments:call'
  )![1]
  return handler(null, { selector: environment.id, method: 'terminal.send', params, timeoutMs })
}
const prompt = (text: string) => ({ terminal: 'terminal', chatPrompt: { agent: 'claude', text } })
const prepared = () => ({ environment, expected: { runtimeId: 'runtime' } })

beforeEach(() => {
  vi.useFakeTimers()
  mocks.handle.mockReset()
  mocks.send
    .mockReset()
    .mockResolvedValue({ ok: true, result: {}, _meta: { runtimeId: 'runtime' } })
  mocks.accounts.mockReset().mockImplementation(async ({ params }) => ({ ok: true, params }))
  mocks.prepare.mockReset().mockResolvedValue(prepared())
  registerRuntimeEnvironmentPassiveHandlers(() => '/tmp/sta14532-chat-deadline')
})
afterEach(() => vi.useRealTimers())

it('never first-dispatches input after account preparation outlives its absolute deadline', async () => {
  const accounts = Promise.withResolvers<unknown>()
  mocks.accounts.mockReturnValue(accounts.promise)
  const pending = call(prompt('expired before queue'), 1_000)
  const expired = expect(pending).rejects.toThrow('Chat input request expired')
  await vi.advanceTimersByTimeAsync(1_000)
  accounts.resolve({ ok: true, params: prompt('expired before queue') })
  await expired
  expect(mocks.send).not.toHaveBeenCalled()
})

it('prevents late first dispatch from queued or already-preparing work while raw input stays available', async () => {
  const preparation = Promise.withResolvers<ReturnType<typeof prepared>>()
  const active = Promise.withResolvers<void>()
  let preparing = 0
  mocks.prepare.mockImplementation(
    async (_path, _selector, _method, _preparation, _expected, signal) => {
      if (signal) {
        if (++preparing === 8) {
          active.resolve()
        }
        return preparation.promise
      }
      return prepared()
    }
  )
  const running = Array.from({ length: 8 }, (_, index) => call(prompt(`blocked-${index}`), 1_000))
  const refused = running.map((pending) =>
    expect(pending).rejects.toThrow('Chat input request expired')
  )
  await active.promise
  const queued = expect(call(prompt('queued'), 1_000)).rejects.toThrow('Chat input request expired')
  await expect(call({ terminal: 'terminal', text: 'raw' })).resolves.toMatchObject({ ok: true })
  await vi.advanceTimersByTimeAsync(1_000)
  await queued
  preparation.resolve(prepared())
  await Promise.all(refused)
  expect(mocks.send.mock.calls.map((args) => args[3])).toEqual([
    { terminal: 'terminal', text: 'raw' }
  ])
})
