import { callRuntimeEnvironment } from './requests/runtime-environment-transport-routing'
import * as ChatBudget from '../../../shared/terminal/input/terminal-chat-prompt-budget'
import { TERMINAL_CHAT_PROMPT_EXPIRY_RUNTIME_CAPABILITY } from '../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as EnvironmentCatalog from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import type * as AbortableRequests from './requests/runtime-environment-abortable-requests'

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
  send: vi.fn(),
  oneShot: vi.fn(),
  clock: { lower: 100000, upper: 100001 }
}))
vi.mock('../../startup/main-process-state', () => ({
  mainProcessState: { runtime: { getRuntimeId: () => 'main' } }
}))
vi.mock('../../runtime/hosts/runtime-elapsed-clock', () => ({
  readRuntimeElapsedClock: () => mocks.clock
}))
vi.mock('./requests/runtime-environment-runtime-pinned-send', () => ({
  sendOneShotRequestOnRuntime: mocks.oneShot,
  sendEnvelopedOneShotCall: vi.fn()
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
vi.mock('./requests/runtime-environment-request-preparation', () => ({
  prepareFencedRuntimeRequest: mocks.prepare
}))
vi.mock('./requests/runtime-environment-abortable-requests', async (original) => ({
  ...(await original<typeof AbortableRequests>()),
  sendRemoteRuntimeConnectionRequestAbortable: mocks.send
}))

import { registerRuntimeEnvironmentPassiveHandlers } from './connectivity/runtime-environment-connectivity-handlers'

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
  mocks.clock.lower = 100000
  mocks.clock.upper = 100001
  mocks.oneShot.mockReset()
  mocks.send
    .mockReset()
    .mockResolvedValue({ ok: true, result: {}, _meta: { runtimeId: 'runtime' } })
  mocks.accounts.mockReset().mockImplementation(async ({ params }) => ({ ok: true, params }))
  mocks.prepare.mockReset().mockResolvedValue(prepared())
  registerRuntimeEnvironmentPassiveHandlers(() => '/tmp/sta14532-chat-deadline')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

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

it('maps the sending socket status into its own clock and keeps qualified Chat off the raw cached transport', async () => {
  mocks.oneShot.mockImplementation(async (_connection, selected) => {
    const params = selected.requestSelection.paramsForStatus({
      runtimeId: 'runtime',
      elapsedClockMs: 900000,
      capabilities: ['terminal.chat-prompt-expiry.v1']
    })
    expect(params.chatPrompt.expiry).toEqual({ runtimeId: 'runtime', expiresAtMs: 904999 })
    selected.requestSelection.onDispatch()
    return { ok: true, result: { send: { accepted: true } }, _meta: { runtimeId: 'runtime' } }
  })
  const params = {
    terminal: 'terminal',
    chatPrompt: {
      agent: 'claude',
      text: 'body',
      expiry: { runtimeId: 'main', expiresAtMs: 105000 }
    }
  }
  await expect(call(params)).resolves.toMatchObject({ ok: true })
  expect(mocks.send).not.toHaveBeenCalled()
  expect(mocks.oneShot).toHaveBeenCalledOnce()
})

it('never remaps an expired main grant after delayed account work even before timeout callbacks run', async () => {
  const params = {
    terminal: 'terminal',
    chatPrompt: {
      agent: 'claude',
      text: 'body',
      expiry: { runtimeId: 'main', expiresAtMs: 105000 }
    }
  }
  mocks.accounts.mockImplementation(async () => {
    mocks.clock.lower = 105001
    mocks.clock.upper = 105002
    return { ok: true, params }
  })
  await expect(call(params)).rejects.toThrow('Chat input request expired')
  expect(mocks.oneShot).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalled()
})

it('returns an explicit zero-mutation fallback only when the sending runtime declares no expiry support', async () => {
  mocks.oneShot.mockImplementation(async (_connection, selected) => {
    selected.requestSelection.paramsForStatus({ runtimeId: 'runtime', capabilities: [] })
  })
  await expect(
    call({
      terminal: 'terminal',
      chatPrompt: {
        agent: 'claude',
        text: 'body',
        expiry: { runtimeId: 'main', expiresAtMs: 105000 }
      }
    })
  ).resolves.toMatchObject({
    ok: true,
    result: { send: { accepted: false, bytesWritten: 0, chatPromptNotDispatched: 'unsupported' } }
  })
  expect(mocks.send).not.toHaveBeenCalled()
})

it.each([1, 10])(
  'derives each remote Send schedule once across selection, preparation and early expiry wakes (%i sends)',
  async (count) => {
    const schedule = vi.spyOn(ChatBudget, 'terminalChatPromptSchedule')
    mocks.oneShot.mockImplementation(async (_connection, selected) => {
      const selection = selected.requestSelection
      const status = {
        runtimeId: 'runtime',
        elapsedClockMs: 0,
        capabilities: [TERMINAL_CHAT_PROMPT_EXPIRY_RUNTIME_CAPABILITY]
      }
      selection.paramsForStatus(status)
      selection.paramsForStatus(status)
      selected.prepareRequest({ params: {} })
      selection.onDispatch()
      // An early timer wake cannot re-derive the invariant payload schedule.
      await vi.advanceTimersByTimeAsync(5000)
      selection.onDispatch()
      return { ok: true, result: { send: { accepted: true } }, _meta: { runtimeId: 'runtime' } }
    })
    for (let index = 0; index < count; index++) {
      await expect(
        call({
          terminal: 'terminal',
          chatPrompt: {
            agent: 'claude',
            text: 'x'.repeat(100000),
            expiry: { runtimeId: 'main', expiresAtMs: 105000 }
          }
        })
      ).resolves.toMatchObject({ ok: true, result: { send: { accepted: true } } })
    }
    expect(schedule).toHaveBeenCalledTimes(count)
  }
)

it('rejects a destination identity in the originating grant before account preparation', async () => {
  await expect(
    call({
      terminal: 'terminal',
      chatPrompt: {
        agent: 'claude',
        text: 'body',
        expiry: { runtimeId: 'runtime', expiresAtMs: 110000 }
      }
    })
  ).rejects.toThrow('Chat input request expired')
  expect(mocks.accounts).not.toHaveBeenCalled()
  expect(mocks.oneShot).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalled()
})

it('rejects an expiring direct route without trusted originating context before opening a sending socket', async () => {
  await expect(
    callRuntimeEnvironment('/tmp/sta14532-chat-deadline', 'host', 'terminal.send', {
      terminal: 'terminal',
      chatPrompt: {
        agent: 'claude',
        text: 'body',
        expiry: { runtimeId: 'main', expiresAtMs: 110000 }
      }
    })
  ).rejects.toThrow('Chat input request expired')
  expect(mocks.oneShot).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalled()
})
