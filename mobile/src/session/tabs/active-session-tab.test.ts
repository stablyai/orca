import { describe, expect, it } from 'vitest'
import { resolveActiveSessionTab } from './active-session-tab'

type Tab = { id: string; type: 'terminal' | 'browser' | 'agent-session'; isActive: boolean }

function terminalTab(id: string, isActive: boolean): Tab {
  return { id, type: 'terminal', isActive }
}

function browserTab(id: string, isActive: boolean): Tab {
  return { id, type: 'browser', isActive }
}

describe('resolveActiveSessionTab', () => {
  it('lets explicit follow supersede an in-flight local activation', () => {
    const result = resolveActiveSessionTab(
      [terminalTab('agent', true), browserTab('browser', false)],
      {
        pendingActiveSessionTabId: 'browser',
        selectedSessionTabId: 'browser',
        navigationIntent: 'follow'
      }
    )

    expect(result.activeTab?.id).toBe('agent')
    expect(result.selectionSource).toBe('navigation-intent')
    expect(result.clearPendingActiveSessionTabId).toBe(true)
  })

  it('falls back to the snapshot but retains the pick while the selected tab is missing', () => {
    const gap = resolveActiveSessionTab([terminalTab('agent', true)], {
      pendingActiveSessionTabId: null,
      selectedSessionTabId: 'browser'
    })

    expect(gap.activeTab?.id).toBe('agent')
    expect(gap.retainSelectedSessionTabId).toBe(true)

    const restored = resolveActiveSessionTab(
      [terminalTab('agent', true), browserTab('browser', false)],
      { pendingActiveSessionTabId: null, selectedSessionTabId: 'browser' }
    )
    expect(restored.activeTab?.id).toBe('browser')
  })
})
