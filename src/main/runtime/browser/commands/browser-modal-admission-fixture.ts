import { EventEmitter } from 'node:events'
import { expect, vi } from 'vitest'
import { RuntimeBrowserCommands } from './browser-commands'
import type { BrowserTabBarEntry } from '../tabs/browser-tab-listing'
import type { RuntimeBrowserCommandHost } from './browser-command-contracts'
import { AgentBrowserBridge } from '../../../browser/agent-browser/agent-browser-bridge'
import { mockBrowserManager } from '../../../browser/agent-browser/testing/agent-browser-bridge-test-harness'
import { installBrowserJavaScriptDialogs } from '../../../browser/guest-lifecycle/prompts/browser-javascript-dialogs'
import {
  prepareBrowserPageAttach,
  admitBrowserPageAttach,
  associateBrowserPageAttach,
  startBrowserPageAttach,
  waitForBrowserPageReady,
  reserveBrowserPageDiscard,
  acknowledgeBrowserPageRemoval
} from '../../../browser/guest-lifecycle/browser-page-memory'

const pageId = 'modal-page'
let nextId = 700
export function createModalAdmissionFixture(
  native: { guests: Map<number, Electron.WebContents> },
  ownedPages: Set<string>
) {
  const managedPages = new Set<string>()
  const catalog: BrowserTabBarEntry[] = []
  const tabs = new Map<string, number>()
  const worktrees = new Map<string, string>()
  const bridge = new AgentBrowserBridge(mockBrowserManager(tabs, worktrees))
  let activate: (page?: string) => void = () => {}
  const send = vi.fn(
    (_channel: string, payload: { browserPageId?: string; worktreeId?: string }) => {
      if (!payload.worktreeId || payload.worktreeId === 'workspace') {
        activate(payload.browserPageId)
      }
    }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connected command host supplies only reached registry, activation and scoped catalog surfaces.
  const host = {
    getAgentBrowserBridge: () => bridge,
    getRuntimeBrowserPageRegistry: () => ({
      getPage: (page: string) => (managedPages.has(page) ? { browserPageId: page } : undefined)
    }),
    getAuthoritativeWindow: () => ({ webContents: { send } }),
    resolveWorkspaceSelector: async (selector: string) => {
      if (selector === 'reject') {
        throw new Error('Unknown workspace')
      }
      return { id: selector }
    },
    readBrowserTabBar: () => catalog
  } as unknown as RuntimeBrowserCommandHost
  const commands = new RuntimeBrowserCommands(host)
  const attach = (page = pageId, register = true) => {
    const id = ++nextId
    ownedPages.add(page)
    const marker = prepareBrowserPageAttach(page, 99, 'persist:modal', 'https://localhost/app')
    admitBrowserPageAttach(marker, 99, 'persist:modal')
    let destroyed = false
    let loading = true
    const events = new EventEmitter()
    const load = vi.fn(async () => {})
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deterministic native attach, pending load, dialog and certificate event fixture.
    const guest = Object.assign(events, {
      id,
      hostWebContents: { id: 99 },
      session: { webRequest: { onBeforeRequest: vi.fn() } },
      getType: () => 'webview',
      getURL: () => 'https://localhost/app',
      getTitle: () => 'Modal',
      isDestroyed: () => destroyed,
      isLoading: () => loading,
      isDevToolsOpened: () => false,
      debugger: Object.assign(new EventEmitter(), { isAttached: () => false }),
      loadURL: load,
      navigationHistory: {
        getAllEntries: () => [{ url: 'https://localhost/app', title: 'Modal' }],
        getActiveIndex: () => 0,
        restore: () => new Promise<void>(() => {})
      },
      close: () => {
        destroyed = true
        guest.emit('destroyed')
      }
    }) as unknown as Electron.WebContents
    native.guests.set(id, guest)
    associateBrowserPageAttach(guest)
    startBrowserPageAttach(guest)
    guest.emit('did-start-navigation', {
      url: guest.getURL(),
      isSameDocument: false,
      isMainFrame: true
    })
    installBrowserJavaScriptDialogs(guest, () => null)
    if (register) {
      tabs.set(page, id)
      worktrees.set(page, 'workspace')
      bridge.setActiveTab(id)
    }
    return {
      guest,
      load,
      finish: async () => {
        loading = false
        guest.emit('did-navigate', {}, guest.getURL())
        guest.emit('did-finish-load')
        await waitForBrowserPageReady(page, guest)
      }
    }
  }
  const cold = async (page = pageId) => {
    const first = attach(page)
    await first.finish()
    expect(reserveBrowserPageDiscard(page, first.guest)).toBe(true)
    await acknowledgeBrowserPageRemoval(page, first.guest, 99)
    tabs.delete(page)
  }
  return {
    commands,
    managedPages,
    attach,
    cold,
    catalog,
    tabs,
    worktrees,
    bridge,
    send,
    onActivate: (callback: typeof activate) => {
      activate = callback
    }
  }
}
