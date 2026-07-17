import { describe, expect, it } from 'vitest'
import type { MobileBrowserTab } from '../browser/MobileBrowserPane'
import { resolveActiveSessionTab } from './active-session-tab'

type SessionTab =
  | { type: 'terminal'; id: string; title: string; terminal: string | null; isActive: boolean }
  | { type: 'markdown'; id: string; title: string; isActive: boolean }
  | MobileBrowserTab

function browserTab(id: string, isActive: boolean): MobileBrowserTab {
  return {
    type: 'browser',
    id,
    title: id,
    browserWorkspaceId: 'browser-workspace',
    browserPageId: id,
    url: `https://${id}.example.com/`,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isActive
  }
}

function terminalTab(id: string, isActive: boolean): Extract<SessionTab, { type: 'terminal' }> {
  return {
    type: 'terminal',
    id,
    title: id,
    terminal: id,
    isActive
  }
}

describe('resolveActiveSessionTab', () => {
  it('keeps a still-present browser tab active when a later snapshot marks Agent active', () => {
    const result = resolveActiveSessionTab(
      [terminalTab('agent', true), browserTab('browser', false)],
      {
        pendingActiveSessionTabId: null,
        currentActiveSessionTabId: 'browser'
      }
    )

    expect(result).toEqual({
      activeTab: expect.objectContaining({ id: 'browser', type: 'browser' }),
      clearPendingActiveSessionTabId: false
    })
  })

  it('falls back to the snapshot when the current browser tab is gone', () => {
    const result = resolveActiveSessionTab([terminalTab('agent', true)], {
      pendingActiveSessionTabId: null,
      currentActiveSessionTabId: 'browser'
    })

    expect(result).toEqual({
      activeTab: expect.objectContaining({ id: 'agent', type: 'terminal' }),
      clearPendingActiveSessionTabId: false
    })
  })

  it('keeps non-browser current tabs under snapshot control', () => {
    const result = resolveActiveSessionTab(
      [terminalTab('agent', false), terminalTab('shell', true)],
      {
        pendingActiveSessionTabId: null,
        currentActiveSessionTabId: 'agent'
      }
    )

    expect(result).toEqual({
      activeTab: expect.objectContaining({ id: 'shell', type: 'terminal' }),
      clearPendingActiveSessionTabId: false
    })
  })

  it('keeps a pending activation authoritative until the snapshot catches up', () => {
    const result = resolveActiveSessionTab(
      [terminalTab('agent', true), browserTab('browser', false)],
      {
        pendingActiveSessionTabId: 'browser',
        currentActiveSessionTabId: 'agent'
      }
    )

    expect(result).toEqual({
      activeTab: expect.objectContaining({ id: 'browser', type: 'browser' }),
      clearPendingActiveSessionTabId: false
    })
  })

  it('clears a pending activation once the snapshot acknowledges it', () => {
    const result = resolveActiveSessionTab(
      [browserTab('browser', true), terminalTab('agent', false)],
      {
        pendingActiveSessionTabId: 'browser',
        currentActiveSessionTabId: 'agent'
      }
    )

    expect(result).toEqual({
      activeTab: expect.objectContaining({ id: 'browser', type: 'browser' }),
      clearPendingActiveSessionTabId: true
    })
  })

  it('clears a stale pending activation when its tab is gone and no browser tab is current', () => {
    const result = resolveActiveSessionTab([terminalTab('agent', true)], {
      pendingActiveSessionTabId: 'removed-tab',
      currentActiveSessionTabId: 'agent'
    })

    expect(result).toEqual({
      activeTab: expect.objectContaining({ id: 'agent', type: 'terminal' }),
      clearPendingActiveSessionTabId: true
    })
  })
})
