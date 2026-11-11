import { EventEmitter } from 'node:events'
import { afterEach, vi } from 'vitest'
import { RuntimeBrowserCommands } from './browser-commands'
import { runWithActiveRpcCaller } from '../../rpc/rpc-active-caller'
import { LOCAL_CLI_RPC_CALLER } from '../../rpc/rpc-caller-identity'
import {
  prepareBrowserPageAttach,
  admitBrowserPageAttach,
  associateBrowserPageAttach,
  startBrowserPageAttach,
  waitForBrowserPageReady,
  closeBrowserMemoryPage,
  closeBrowserMemoryRenderer
} from '../../../browser/guest-lifecycle/browser-page-memory'
import type { RuntimeBrowserCommandHost } from './browser-command-contracts'
import type { BrowserTabCreateRequest } from '../../../../shared/browser-tab-create-request'

const { ipc, guests, registration } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return {
    ipc: new EventEmitter(),
    guests: new Map<number, Electron.WebContents>(),
    registration: vi.fn(async () => {})
  }
})
vi.mock('electron', () => ({
  ipcMain: ipc,
  webContents: { fromId: (id: number) => guests.get(id) }
}))
vi.mock('../../../browser/sessions/profiles/browser-session-registry', () => ({
  browserSessionRegistry: {
    resolveKnownPartition: () => 'persist:profile',
    getDefaultProfile: () => ({ id: 'default', partition: 'persist:profile' })
  }
}))
vi.mock(
  '../../../browser/guest-lifecycle/manager/registration/browser-guest-discard-protection',
  () => ({
    markInitialBrowserGuest: vi.fn(),
    readBrowserGuestDiscardProtection: () => ({ protection: 'discardable' })
  })
)
vi.mock('../../../browser/guest-lifecycle/browser-main-window-readiness', () => ({
  whenBrowserMainWindowReady: async () => null
}))
vi.mock('../../../ipc/browser/browser-tab-registration-wait', () => ({
  waitForTabRegistration: registration,
  waitForTabFirstLoad: async () => {},
  waitForWorktreeTabRegistration: async () => {}
}))
vi.mock('../../../window/renderer-publication-throttle', () => ({
  rendererPublicationThrottle: { acquire: () => () => {} }
}))

const ids = new Set<string>()
afterEach(() => {
  for (const id of ids) {
    closeBrowserMemoryPage(id)
  }
  ids.clear()
  guests.clear()
  ipc.removeAllListeners()
  registration.mockReset()
})
let nextGuest = 1000
export async function attach(pageId: string, rendererId = 99) {
  ids.add(pageId)
  const marker = prepareBrowserPageAttach(
    pageId,
    rendererId,
    'persist:profile',
    'https://example.test/'
  )
  admitBrowserPageAttach(marker, rendererId, 'persist:profile')
  let destroyed = false
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture implements exact native attach/load/retirement surface, with real main ownership code.
  const guest = Object.assign(new EventEmitter(), {
    id: ++nextGuest,
    hostWebContents: { id: rendererId },
    getType: () => 'webview',
    isDestroyed: () => destroyed,
    isLoading: () => false,
    isDevToolsOpened: () => false,
    debugger: { isAttached: () => false },
    loadURL: async () => {},
    navigationHistory: {
      getAllEntries: () => [{ url: 'https://example.test/', title: 'Page' }],
      getActiveIndex: () => 0
    },
    close: () => {
      destroyed = true
      guest.emit('destroyed')
    }
  }) as unknown as Electron.WebContents
  guests.set(guest.id, guest)
  associateBrowserPageAttach(guest)
  startBrowserPageAttach(guest)
  await waitForBrowserPageReady(pageId, guest)
  return guest
}
export function rig() {
  let available = true
  let creatorDead = false
  const requests: BrowserTabCreateRequest[] = []
  const registered = new Map<string, number>()
  const renderer = {
    id: 99,
    isDestroyed: () => creatorDead,
    send: (channel: string, request: BrowserTabCreateRequest) => {
      if (channel === 'browser:requestTabCreate') {
        requests.push(request)
      }
    }
  }
  let finishNavigation: () => void = () => {}
  let navigationStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    navigationStarted = resolve
  })
  const pendingNavigation = new Promise<void>((resolve) => {
    finishNavigation = resolve
  })
  const bridge = {
    getRegisteredTabs: () => registered,
    setActiveTab: () => {},
    getActivePageId: () => null,
    goto: async () => {
      navigationStarted()
      await pendingNavigation
      return { url: 'https://example.test/', title: 'Page' }
    }
  }
  const offscreen = {
    createTab: vi.fn(async ({ browserPageId }: { browserPageId: string }) => ({ browserPageId }))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: real production create dispatch reaches exactly these desktop/offscreen host paths.
  const host = {
    getAgentBrowserBridge: () => bridge,
    getRuntimeBrowserPageRegistry: () => ({ getPage: () => undefined }),
    getAvailableAuthoritativeWindow: () => (available ? { webContents: renderer } : null),
    getAuthoritativeWindow: () => ({ webContents: renderer }),
    getOffscreenBrowserBackend: () => offscreen
  } as unknown as RuntimeBrowserCommandHost
  const commands = new RuntimeBrowserCommands(host)
  const create = (pageId: string, url = 'https://example.test/') => {
    ids.add(pageId)
    return runWithActiveRpcCaller(LOCAL_CLI_RPC_CALLER, () =>
      commands.browserTabCreate({ page: pageId, url, waitForRegistration: false })
    )
  }
  const reply = (error?: string) => {
    const request = requests.shift()
    if (!request) {
      throw new Error('Missing real renderer creation request')
    }
    ipc.emit(
      'browser:tabCreateReply',
      { sender: renderer },
      {
        requestId: request.requestId,
        browserPageId: request.browserPageId,
        ...(error ? { error } : {})
      }
    )
  }
  return {
    commands,
    create,
    reply,
    started,
    finishNavigation,
    offscreen,
    registration,
    unavailable: () => {
      available = false
    },
    available: () => {
      available = true
    },
    destroy: () => {
      creatorDead = true
      closeBrowserMemoryRenderer(99)
    }
  }
}
