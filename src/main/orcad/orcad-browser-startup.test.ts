import { afterEach, expect, it, vi } from 'vitest'
import { startOrcadBrowserProvider } from './orcad-browser-startup'
import { resolveOrcadBrowserProvider, type OrcadBrowserProvider } from './orcad-browser-provider'
import {
  createRuntimeBrowserCommands,
  runtimeBrowserCommandsFactoryIsHeadless,
  setRuntimeBrowserCommandsFactory,
  setRuntimeBrowserUnavailableCause
} from '../runtime/runtime-browser-commands-factory'

import type { RuntimeBrowserCommandHost } from '../runtime/browser/browser-command-contracts'
import type { RuntimeBrowserCommands } from '../runtime/browser/browser-commands'
import { RuntimeBrowserPageRegistry } from '../runtime/runtime-browser-page-registry'
import { RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT } from '../runtime/client-hosted-browser-page-persistence'

vi.mock('./orcad-browser-provider', () => ({ resolveOrcadBrowserProvider: vi.fn() }))
afterEach(() => {
  vi.restoreAllMocks()
  setRuntimeBrowserCommandsFactory(null)
  setRuntimeBrowserUnavailableCause(null)
})

const host: RuntimeBrowserCommandHost = Object.assign(Object.create(null), {
  getRuntimeBrowserPageRegistry: () => new RuntimeBrowserPageRegistry(),
  getBrowserHostLeaseRegistry: () => ({
    select: () => {
      throw new Error('browser_host_unavailable')
    }
  })
})
function delayedProvider() {
  const pending = Promise.withResolvers<OrcadBrowserProvider | null>()
  vi.mocked(resolveOrcadBrowserProvider).mockReturnValueOnce(pending.promise)
  const command = vi.fn(() => ({ tabs: [] }))
  const provider: OrcadBrowserProvider = {
    kind: 'electron',
    factory: vi.fn((): RuntimeBrowserCommands =>
      Object.assign(Object.create(null), { browserTabList: command })
    ),
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

function closeHost(pages: RuntimeBrowserPageRegistry): RuntimeBrowserCommandHost {
  pages.publishClientPage({
    browserPageId: 'page-restored',
    workspaceId: 'wt-1',
    browserProfileId: 'profile-a',
    executionHostKey: 'restored-client-host-execution',
    placement: RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT,
    pairedDeviceId: 'device-a',
    url: 'https://restored.internal/',
    loading: false,
    active: false
  })
  return Object.assign(Object.create(null), {
    getRuntimeBrowserPageRegistry: () => pages,
    getBrowserHostLeaseRegistry: () => ({ getPlacement: () => undefined }),
    resolveBrowserWorkspace: async (selector: string) => ({ id: selector.replace(/^id:/, '') }),
    resolveWorkspaceSelector: async (selector: string) => ({ id: selector.replace(/^id:/, '') }),
    retireRuntimeOwnedBrowserSessionTab: vi.fn(() => true)
  })
}

it('closes a held client-hosted page when discovery found no browser provider', async () => {
  const { pending, startup } = delayedProvider()
  const pages = new RuntimeBrowserPageRegistry()
  const commands = createRuntimeBrowserCommands(closeHost(pages))
  pending.resolve(null)
  await startup.ready
  await expect(
    commands.browserTabClose({ worktree: 'id:wt-1', page: 'page-restored' })
  ).resolves.toEqual({ closed: true })
  expect(pages.getPage('page-restored')).toBeUndefined()
  await startup.stop()
})
