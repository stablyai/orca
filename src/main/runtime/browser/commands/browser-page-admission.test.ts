import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { RuntimeBrowserCommandTargets } from './browser-command-targets'
import { RuntimeBrowserCommands } from './browser-commands'
import {
  prepareBrowserPageAttach,
  admitBrowserPageAttach,
  associateBrowserPageAttach,
  startBrowserPageAttach,
  reserveBrowserPageDiscard,
  acknowledgeBrowserPageRemoval,
  waitForBrowserPageReady,
  closeBrowserMemoryPage
} from '../../../browser/guest-lifecycle/browser-page-memory'
import type { RuntimeBrowserCommandHost } from './browser-command-contracts'
const { native } = vi.hoisted(() => {
  const native: { guest: Electron.WebContents | null } = { guest: null }
  return { native }
})
vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: () => native.guest }
}))
vi.mock(
  '../../../browser/guest-lifecycle/manager/registration/browser-guest-discard-protection',
  () => ({
    markInitialBrowserGuest: vi.fn(),
    readBrowserGuestDiscardProtection: () => ({ protection: 'discardable' })
  })
)
vi.mock('../../../ipc/browser/browser-tab-registration-wait', () => ({
  waitForTabRegistration: async () => {},
  waitForTabFirstLoad: async () => {},
  waitForWorktreeTabRegistration: async () => {}
}))
vi.mock('../../../browser/guest-lifecycle/browser-main-window-readiness', () => ({
  whenBrowserMainWindowReady: async () => null
}))
vi.mock('../../../runtime/rpc/rpc-active-caller', () => ({
  getActiveRpcCaller: () => ({ kind: 'desktop' })
}))

it('does not execute an admitted page command before restored load, and propagates navigation failure', async () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native event fixture exposes the page gate's exact surface.
  const guest = Object.assign(new EventEmitter(), {
    id: 10,
    isDestroyed: () => false,
    isLoading: () => true
  }) as unknown as Electron.WebContents
  native.guest = guest
  const tabs = new Map<string, number>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this focused host exercises only activation, registration and resolution.
  const host = {
    getAgentBrowserBridge: () => ({
      getRegisteredTabs: () => tabs,
      getActivePageId: () => 'gate-page'
    }),
    getAuthoritativeWindow: () => ({ webContents: { send: () => tabs.set('gate-page', 10) } }),
    resolveWorkspaceSelector: async () => ({ id: 'workspace' })
  } as unknown as RuntimeBrowserCommandHost
  const targets = new RuntimeBrowserCommandTargets(host)
  const action = vi.fn(async () => 'ready')
  const pending = targets.withPageOperation({ page: 'gate-page' }, action)
  // Flush activation/registration microtasks; no clock or wall-time assertion.
  for (let i = 0; i < 8; i++) {
    await Promise.resolve()
  }
  expect(action).not.toHaveBeenCalled()
  guest.emit('did-finish-load')
  await expect(pending).resolves.toBe('ready')
  const failed = targets.withPageOperation({ page: 'gate-page' }, action)
  for (let i = 0; i < 8; i++) {
    await Promise.resolve()
  }
  guest.emit('did-fail-load', {}, -106, 'Offline', 'https://example.test/', true)
  await expect(failed).rejects.toThrow('Offline')
  expect(action).toHaveBeenCalledOnce()
})

it('runs production reload after a failed cold restore, then admits an ordinary command', async () => {
  const pageId = 'recovery-page'
  const attach = (id: number) => {
    const marker = prepareBrowserPageAttach(pageId, 99, 'persist:profile', 'https://example.test/')
    admitBrowserPageAttach(marker, 99, 'persist:profile')
    let destroyed = false
    let loading = true
    const reloadNative = vi.fn(async () => {
      loading = false
      guest.emit('did-finish-load')
      return { url: 'https://example.test/', title: 'Recovered' }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture models native attach/load events and the recovery command's underlying action.
    const guest = Object.assign(new EventEmitter(), {
      id,
      hostWebContents: { id: 99 },
      getType: () => 'webview',
      isDestroyed: () => destroyed,
      isLoading: () => loading,
      isDevToolsOpened: () => false,
      debugger: { isAttached: () => false },
      loadURL: () => new Promise<void>(() => {}),
      navigationHistory: {
        getAllEntries: () => [{ url: 'https://example.test/', title: 'Original' }],
        getActiveIndex: () => 0,
        restore: vi.fn(() => new Promise<void>(() => {}))
      },
      close: () => {
        destroyed = true
        guest.emit('destroyed')
      }
    }) as unknown as Electron.WebContents
    associateBrowserPageAttach(guest)
    startBrowserPageAttach(guest)
    native.guest = guest
    return {
      guest,
      reloadNative,
      finish: () => {
        loading = false
        guest.emit('did-finish-load')
      },
      fail: () => {
        loading = false
        guest.emit('did-fail-load', {}, -106, 'Offline', 'https://example.test/', true)
      }
    }
  }
  try {
    const first = attach(20)
    first.finish()
    await waitForBrowserPageReady(pageId, first.guest)
    expect(reserveBrowserPageDiscard(pageId, first.guest)).toBe(true)
    await acknowledgeBrowserPageRemoval(pageId, first.guest, 99)
    const cold = attach(21)
    const snapshot = vi.fn(async () => ({ snapshot: 'Recovered page' }))
    const bridge = {
      getRegisteredTabs: () => new Map([[pageId, 21]]),
      getActivePageId: () => pageId,
      snapshot,
      reload: cold.reloadNative
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only production reload and snapshot host paths are reached.
    const host = {
      getAgentBrowserBridge: () => bridge,
      getRuntimeBrowserPageRegistry: () => ({ getPage: () => undefined }),
      getAuthoritativeWindow: () => ({ webContents: { send: vi.fn() } })
    } as unknown as RuntimeBrowserCommandHost
    const commands = new RuntimeBrowserCommands(host)
    const failed = commands.browserSnapshot({ page: pageId })
    for (let i = 0; i < 8; i++) {
      await Promise.resolve()
    }
    expect(snapshot).not.toHaveBeenCalled()
    cold.fail()
    await expect(failed).rejects.toThrow('Offline')
    await expect(commands.browserSnapshot({ page: pageId })).rejects.toThrow(
      'could not be restored'
    )
    await expect(commands.browserReload({ page: pageId })).resolves.toEqual({
      url: 'https://example.test/',
      title: 'Recovered'
    })
    expect(cold.reloadNative).toHaveBeenCalledOnce()
    await expect(commands.browserSnapshot({ page: pageId })).resolves.toEqual({
      snapshot: 'Recovered page'
    })
    expect(snapshot).toHaveBeenCalledOnce()
  } finally {
    closeBrowserMemoryPage(pageId)
  }
})
