import { describe, expect, it } from 'vitest'
import type { MobileSessionTab } from './mobile-session-route-types'
import { PendingTerminalHandleRecoveryContextCache } from './pending-terminal-handle-recovery'

function terminalTab(id: string, terminal: string | null): MobileSessionTab {
  return {
    type: 'terminal',
    id,
    title: 'zsh',
    parentTabId: 'parent',
    leafId: 'leaf',
    status: terminal === null ? 'pending-handle' : 'ready',
    terminal,
    isActive: true
  }
}

describe('PendingTerminalHandleRecoveryContextCache', () => {
  it('reads authoritative tab refs before the next render', () => {
    const cache = new PendingTerminalHandleRecoveryContextCache()
    const pendingTabs = [terminalTab('terminal-a', null)]
    const readyTabs = [terminalTab('terminal-a', 'pty-a')]

    expect(cache.read(pendingTabs, 'terminal-a')).not.toBeNull()
    expect(cache.read(readyTabs, 'terminal-a')).toBeNull()
    expect(cache.read(pendingTabs, null)).toBeNull()
    expect(cache.read(pendingTabs, 'terminal-a')).not.toBeNull()
  })

  it('recomputes when the pending terminal identity changes', () => {
    const cache = new PendingTerminalHandleRecoveryContextCache()
    const first = terminalTab('terminal-a', null)
    const parentChanged = { ...first, parentTabId: 'other-parent' }
    const leafChanged = { ...first, leafId: 'other-leaf' }
    const collisionLeft = { ...first, parentTabId: 'ab', leafId: 'c' }
    const collisionRight = { ...first, parentTabId: 'a', leafId: 'bc' }
    const firstKey = cache.read([first], first.id)

    expect(cache.read([parentChanged], parentChanged.id)).not.toBe(firstKey)
    expect(cache.read([leafChanged], leafChanged.id)).not.toBe(firstKey)
    const collisionLeftKey = cache.read([collisionLeft], collisionLeft.id)
    expect(cache.read([collisionRight], collisionRight.id)).not.toBe(collisionLeftKey)
  })

  it('does not rescan an unchanged context on the polling hot path', () => {
    let skippedTabIdReads = 0
    const skippedTab = terminalTab('terminal-b', 'pty-b')
    Object.defineProperty(skippedTab, 'id', {
      get: () => {
        skippedTabIdReads += 1
        return 'terminal-b'
      }
    })
    const tabs = [skippedTab, terminalTab('terminal-a', null)]
    const cache = new PendingTerminalHandleRecoveryContextCache()

    const contextKey = cache.read(tabs, 'terminal-a')
    const readsAfterFirstLookup = skippedTabIdReads
    expect(readsAfterFirstLookup).toBeGreaterThan(0)
    expect(cache.read(tabs, 'terminal-a')).toBe(contextKey)
    expect(skippedTabIdReads).toBe(readsAfterFirstLookup)
  })
})
