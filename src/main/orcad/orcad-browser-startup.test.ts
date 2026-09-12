import { afterEach, expect, it, vi } from 'vitest'
import { startOrcadBrowserProvider } from './orcad-browser-startup'
import { resolveOrcadBrowserProvider, type OrcadBrowserProvider } from './orcad-browser-provider'
import {
  createRuntimeBrowserCommands,
  runtimeBrowserCommandsFactoryIsHeadless,
  runtimeBrowserUnavailableCause,
  setRuntimeBrowserCommandsFactory,
  setRuntimeBrowserUnavailableCause
} from '../runtime/runtime-browser-commands-factory'
import type {
  RuntimeBrowserCommandHost,
  RuntimeBrowserCommands
} from '../runtime/orca-runtime-browser'

vi.mock('./orcad-browser-provider', () => ({ resolveOrcadBrowserProvider: vi.fn() }))
afterEach(() => {
  vi.restoreAllMocks()
  setRuntimeBrowserCommandsFactory(null)
  setRuntimeBrowserUnavailableCause(null)
})

const host = {} as RuntimeBrowserCommandHost
function delayedProvider() {
  const pending = Promise.withResolvers<OrcadBrowserProvider | null>()
  vi.mocked(resolveOrcadBrowserProvider).mockReturnValueOnce(pending.promise)
  const command = vi.fn(() => ({ tabs: [] }))
  const provider: OrcadBrowserProvider = {
    kind: 'electron',
    factory: vi.fn(() => ({ browserTabList: command }) as unknown as RuntimeBrowserCommands),
    isAvailable: vi.fn(() => true),
    stop: vi.fn(async () => {})
  }
  const startup = startOrcadBrowserProvider({ userDataPath: '/private-fixture' })
  return { pending, provider, command, startup }
}

it('returns before discovery and keeps already-created commands usable after readiness', async () => {
  const { pending, provider, command, startup } = delayedProvider()
  const commands = createRuntimeBrowserCommands(host)
  expect(runtimeBrowserCommandsFactoryIsHeadless()).toBe(false)
  expect(() => commands.browserTabList({})).toThrow(/unavailable/)
  pending.resolve(provider)
  await startup.ready
  expect(runtimeBrowserCommandsFactoryIsHeadless()).toBe(true)
  commands.browserTabList({})
  commands.browserTabList({})
  expect(provider.factory).toHaveBeenCalledTimes(1)
  expect(command).toHaveBeenCalledTimes(2)
  await startup.stop()
  expect(() => commands.browserTabList({})).toThrow(/unavailable/)
  expect(runtimeBrowserCommandsFactoryIsHeadless()).toBe(false)
})

it('aborts pending discovery and awaits a late provider cleanup exactly once', async () => {
  const { pending, provider, startup } = delayedProvider()
  await Promise.resolve()
  const signal = vi.mocked(resolveOrcadBrowserProvider).mock.calls.at(-1)![0].signal!
  const stopped = startup.stop()
  expect(startup.stop()).toBe(stopped)
  expect(signal.aborted).toBe(true)
  pending.resolve(provider)
  await stopped
  expect(provider.stop).toHaveBeenCalledTimes(1)
  expect(runtimeBrowserCommandsFactoryIsHeadless()).toBe(false)
})

it('retains specific provider-unavailable diagnostics after discovery declines', async () => {
  const { pending, startup } = delayedProvider()
  setRuntimeBrowserUnavailableCause({ reason: 'driver_missing' })
  pending.resolve(null)
  await startup.ready
  expect(runtimeBrowserUnavailableCause()).toEqual({ reason: 'driver_missing' })
  await startup.stop()
})

it('does not hide resolver cleanup failures from the runtime lifetime', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { pending, startup } = delayedProvider()
  pending.reject(new Error('cleanup failed'))
  await startup.ready
  await expect(startup.stop()).rejects.toThrow('cleanup failed')
})

it('propagates ready-provider cleanup failures', async () => {
  const { pending, provider, startup } = delayedProvider()
  vi.mocked(provider.stop).mockRejectedValueOnce(new Error('stop failed'))
  pending.resolve(provider)
  await startup.ready
  await expect(startup.stop()).rejects.toThrow('stop failed')
})
