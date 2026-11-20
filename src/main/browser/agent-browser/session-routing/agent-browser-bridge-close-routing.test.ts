import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPopupPage } from '../../guest-lifecycle/popups/browser-popup-ownership'
import { AgentBrowserBridge } from '../agent-browser-bridge'
import {
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup
} from '../testing/agent-browser-bridge-test-harness'
import { runWithActiveRpcCaller } from '../../../runtime/rpc/callers/active-call'
import { LOCAL_CLI_RPC_CALLER } from '../../../runtime/rpc/callers/rpc-caller-identity'

const { native } = vi.hoisted(() => ({
  native: new Map<number, ReturnType<typeof mockWebContents>>()
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/routing-test', getAppPath: () => '/routing-test', isPackaged: false },
  webContents: { fromId: (id: number) => native.get(id) }
}))
vi.mock('../helper-process/agent-browser-process-environment', () => ({
  createAgentBrowserProcessEnvironment: () => ({ env: {}, ownsSocketDirectory: false }),
  pointAtEmptyAgentBrowserConfig: async () => {}
}))
vi.mock('../helper-process/agent-browser-binary', () => ({
  resolveAgentBrowserBinary: () => '/unused-helper'
}))
vi.mock('../../cdp/transport/cdp-ws-proxy', () => ({ CdpWsProxy: class {} }))

overrideBridgeWebContentsLookup(
  AgentBrowserBridge.prototype,
  vi.fn((id: number) => native.get(id))
)

// Collection entries reachable from the bridge, so a derived record that outlives its references shows up.
function retainedEntries(root: AgentBrowserBridge): number {
  const seen = new Set<object>()
  let entries = 0
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || seen.has(value)) {
      return
    }
    seen.add(value)
    if (value instanceof Map) {
      entries += value.size
      for (const [key, item] of value) {
        visit(key)
        visit(item)
      }
    } else if (value instanceof Set) {
      entries += value.size
      for (const item of value) {
        visit(item)
      }
    } else if (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype) {
      Object.values(value).forEach(visit)
    }
  }
  Object.values(root).forEach(visit)
  return entries
}

function routingFixture() {
  const tabs = new Map<string, number>()
  const pageByWebContents = new Map<number, string>()
  const worktrees = new Map<string, string>()
  const popups: BrowserPopupPage[] = []
  const destroyed = new Map<number, () => void>()
  const busy = new Set<string>()
  const handOverAgentActivity = vi.fn()
  let nextWebContentsId = 100
  const addNative = (): number => {
    const id = nextWebContentsId++
    native.set(
      id,
      Object.assign(mockWebContents(id), {
        once: (_event: string, listener: () => void) => destroyed.set(id, listener)
      })
    )
    return id
  }
  const bridge = new AgentBrowserBridge(
    mockBrowserManager(tabs, worktrees, {
      // Production resolves guests through a keyed reverse map; the harness default scans every tab.
      getTabIdForWebContentsId: (id: number) => pageByWebContents.get(id) ?? null,
      getPopupPages: () => popups,
      getGuestWebContentsId: (page: string) => tabs.get(page) ?? null,
      isAgentUsingPage: (page: string) => busy.has(page),
      handOverAgentActivity
    })
  )
  return {
    bridge,
    busy,
    handOverAgentActivity,
    register(page: string, worktree: string): number {
      const id = addNative()
      tabs.set(page, id)
      pageByWebContents.set(id, page)
      worktrees.set(page, worktree)
      return id
    },
    // Discard or close: the native guest and its manager worktree mapping are both gone.
    unregister(page: string): void {
      const id = tabs.get(page)
      tabs.delete(page)
      worktrees.delete(page)
      if (id !== undefined) {
        pageByWebContents.delete(id)
        native.delete(id)
      }
    },
    popup(page: string, opener: string): number {
      const id = addNative()
      popups.push({ browserPageId: page, webContentsId: id, openerBrowserPageId: opener })
      return id
    },
    destroyPopup(page: string): void {
      const index = popups.findIndex((popup) => popup.browserPageId === page)
      const [{ webContentsId }] = popups.splice(index, 1)
      native.delete(webContentsId)
      destroyed.get(webContentsId)?.()
    },
    pick: (webContentsId: number, worktree?: string) =>
      bridge.setActiveTab(webContentsId, worktree),
    drive: (webContentsId: number, worktree?: string) =>
      runWithActiveRpcCaller(LOCAL_CLI_RPC_CALLER, () =>
        bridge.setActiveTab(webContentsId, worktree)
      )
  }
}

describe('agent browser close routing cleanup', () => {
  afterEach(() => native.clear())

  it('clears every actual reference on close and keeps references that are still live', async () => {
    const f = routingFixture()
    const x = f.register('X', 'W')
    f.pick(f.register('U', 'U'), 'U')

    f.drive(x, 'W')
    f.busy.add('X')
    const heldOnly = f.register('held-only', 'W')
    f.pick(heldOnly, 'W')
    await f.bridge.onTabClosed(heldOnly)
    f.unregister('held-only')
    f.busy.clear()
    expect(f.bridge.getRoutedPageId('W')).toBe('X')
    expect(f.bridge.getRoutedPageId()).toBe('X')

    f.busy.add('X')
    f.pick(f.register('held-cold', 'W'), 'W')
    f.unregister('held-cold')
    f.busy.clear()
    expect(f.bridge.getRoutedPageId('W')).toBe('held-cold')
    await f.bridge.onPageClosed('held-cold')
    expect(f.bridge.getRoutedPageId('W')).toBeNull()

    const swapped = f.register('swapped', 'W')
    f.pick(swapped, 'W')
    f.busy.add('swapped')
    f.pick(f.register('held-across-swap', 'W'), 'W')
    await f.bridge.onProcessSwap('swapped', f.register('swapped', 'W'), swapped)
    expect(f.bridge.getRoutedPageId('W')).toBe('swapped')
    f.busy.clear()
    expect(f.bridge.getRoutedPageId('W')).toBe('held-across-swap')
    f.unregister('held-across-swap')
    await f.bridge.onPageClosed('held-across-swap')
    expect(f.bridge.getRoutedPageId('W')).toBeNull()

    f.pick(f.register('superseded', 'W'), 'W')
    f.pick(f.register('current', 'W'), 'W')
    f.unregister('superseded')
    await f.bridge.onPageClosed('superseded')
    expect(f.bridge.getRoutedPageId('W')).toBe('current')

    const alias = f.register('alias', 'W')
    f.drive(alias, 'W')
    f.drive(alias, 'V')
    f.pick(f.register('V-other', 'V2'), 'V2')
    await f.bridge.onTabClosed(alias)
    f.unregister('alias')
    // W falls back to its first live sibling; V had no other reference.
    expect([f.bridge.getRoutedPageId('W'), f.bridge.getRoutedPageId('V')]).toEqual(['X', 'V-other'])
    expect(f.bridge.getRoutedPageId('U')).toBe('U')

    f.pick(f.register('cold-route', 'W2'), 'W2')
    f.pick(x, 'W')
    f.unregister('cold-route')
    await f.bridge.onPageClosed('cold-route')
    expect(f.bridge.getRoutedPageId('W2')).toBe('X')
    expect(f.bridge.getRoutedPageId('U')).toBe('U')
  })

  it('hands closed popup routes and held picks to a live opener, and drops them without one', async () => {
    const f = routingFixture()
    f.register('opener', 'W')
    const driven = f.register('driven', 'V')
    const popup = f.popup('popup', 'opener')
    f.drive(popup, 'W')
    f.drive(driven, 'V')
    f.busy.add('driven')
    f.pick(popup, 'V')

    f.destroyPopup('popup')
    await f.bridge.onPageClosed('popup')
    expect(f.handOverAgentActivity).toHaveBeenCalledWith('popup', 'opener')
    expect(f.bridge.getRoutedPageId('W')).toBe('opener')
    expect(f.bridge.getRoutedPageId('V')).toBe('driven')
    f.busy.clear()
    expect(f.bridge.getRoutedPageId('V')).toBe('opener')
    expect(f.bridge.getRoutedPageId()).toBe('opener')

    f.register('gone-opener', 'W3')
    const orphan = f.popup('orphan', 'gone-opener')
    f.drive(orphan, 'W3')
    f.unregister('gone-opener')
    f.destroyPopup('orphan')
    expect(f.bridge.getRoutedPageId('W3')).toBeNull()
    expect(f.bridge.getRoutedPageId('W')).toBe('opener')
  })

  it('returns retained routing entries to baseline after repeated route, hold, popup and close churn', async () => {
    const f = routingFixture()
    f.pick(f.register('X', 'W'), 'W')
    const baseline = retainedEntries(f.bridge)
    for (let i = 0; i < 20; i++) {
      const a = f.register(`a${i}`, 'W')
      const b = f.register(`b${i}`, 'W')
      const popup = f.popup(`p${i}`, `a${i}`)
      f.drive(popup, 'W')
      f.drive(b, 'V')
      f.busy.add(`p${i}`).add(`b${i}`)
      f.pick(a, 'W')
      f.destroyPopup(`p${i}`)
      await f.bridge.onPageClosed(`p${i}`)
      f.busy.clear()
      expect(f.bridge.getRoutedPageId('W')).toBe(`a${i}`)
      await f.bridge.onTabClosed(b)
      f.unregister(`b${i}`)
      expect(f.bridge.getRoutedPageId('V')).toBe(`a${i}`)
      await f.bridge.onTabClosed(a)
      f.unregister(`a${i}`)
      expect([f.bridge.getRoutedPageId('W'), f.bridge.getRoutedPageId()]).toEqual(['X', 'X'])
    }
    expect(retainedEntries(f.bridge)).toBe(baseline)
  })
})
