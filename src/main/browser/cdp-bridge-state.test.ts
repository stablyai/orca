import { describe, expect, it, vi } from 'vitest'

const { webContentsFromIdMock } = vi.hoisted(() => ({
  webContentsFromIdMock: vi.fn()
}))

vi.mock('electron', () => ({
  webContents: { fromId: webContentsFromIdMock }
}))

import type { CdpTabState } from './cdp-auxiliary-commands'
import { CdpBridgeState } from './cdp-bridge-state'
import { CdpTabCommands } from './cdp-tab-commands'

function createBridgeState(
  getRegisteredTabs: () => Map<string, number>,
  getTabIdForWebContentsId: (webContentsId: number) => string | null
) {
  let activeWebContentsId: number | null = null
  const bindings = {
    getActiveWebContentsId: () => activeWebContentsId,
    setActiveWebContentsId: (webContentsId: number | null) => {
      activeWebContentsId = webContentsId
    },
    getRegisteredTabs,
    getTabIdForWebContentsId,
    tabState: new Map<string, CdpTabState>(),
    commandQueues: new Map(),
    processingQueues: new Set<string>()
  }

  return new CdpBridgeState(bindings)
}

describe('CdpBridgeState reverse tab lookup', () => {
  it('resolves repeated lookups from the reverse map without enumerating tabs', () => {
    const tabCount = 1_000
    const lookupCount = 1_000
    const registeredTabs = new Map<string, number>()
    const tabIdByWebContentsId = new Map<number, string>()
    for (let index = 0; index < tabCount; index += 1) {
      const tabId = `tab-${index}`
      const webContentsId = 10_000 + index
      registeredTabs.set(tabId, webContentsId)
      tabIdByWebContentsId.set(webContentsId, tabId)
    }

    const getRegisteredTabs = vi.fn(() => {
      throw new Error('unexpected registered-tab enumeration')
    })
    const getTabIdForWebContentsId = vi.fn(
      (webContentsId: number) => tabIdByWebContentsId.get(webContentsId) ?? null
    )
    const state = createBridgeState(getRegisteredTabs, getTabIdForWebContentsId)
    const targetWebContentsId = 10_000 + tabCount - 1

    // The old forward scan inspected 1,000,000 entries for this repeated last-tab lookup.
    for (let lookup = 0; lookup < lookupCount; lookup += 1) {
      expect(state.resolveTabIdSafe(targetWebContentsId)).toBe(`tab-${tabCount - 1}`)
    }

    expect(getTabIdForWebContentsId).toHaveBeenCalledTimes(lookupCount)
    expect(getRegisteredTabs).not.toHaveBeenCalled()
  })

  it('keeps strict and safe resolution semantics when a registration changes', () => {
    const registeredTabs = new Map([['tab-a', 101]])
    const tabIdByWebContentsId = new Map([[101, 'tab-a']])
    const state = createBridgeState(
      () => registeredTabs,
      (webContentsId) => tabIdByWebContentsId.get(webContentsId) ?? null
    )

    expect(state.resolveTabId(101)).toBe('tab-a')
    expect(state.resolveTabIdSafe(999)).toBeNull()
    expect(() => state.resolveTabId(999)).toThrow('Tab is no longer registered.')

    tabIdByWebContentsId.delete(101)
    tabIdByWebContentsId.set(202, 'tab-a')
    expect(state.resolveTabIdSafe(101)).toBeNull()
    expect(state.resolveTabId(202)).toBe('tab-a')
  })

  it('lets CdpTabCommands read the active page id through the reverse map', () => {
    const tabIdByWebContentsId = new Map([[101, 'tab-a']])
    const getRegisteredTabs = vi.fn(() => {
      throw new Error('unexpected registered-tab enumeration')
    })
    const state = createBridgeState(
      getRegisteredTabs,
      (webContentsId) => tabIdByWebContentsId.get(webContentsId) ?? null
    )
    const commands = new CdpTabCommands(state, {} as never, {} as never, {} as never)

    state.activeWebContentsId = 101
    expect(commands.getActivePageId()).toBe('tab-a')
    state.activeWebContentsId = 999
    expect(commands.getActivePageId()).toBeNull()
    expect(getRegisteredTabs).not.toHaveBeenCalled()
  })
})
