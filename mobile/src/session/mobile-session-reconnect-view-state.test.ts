import { describe, expect, it } from 'vitest'
import { selectMobileSessionReconnectViewState } from './mobile-session-reconnect-view-state'
import {
  getMobileSessionTabStripRows,
  toMobileSessionTabStripPreview,
  type MobileSessionTabStripPreview
} from './mobile-session-tab-strip-entries'
import type { MobileSessionTab } from './mobile-session-route-types'

function terminalTab(id: string, title: string, isActive = false): MobileSessionTab {
  return { type: 'terminal', id, title, terminal: `h-${id}`, isActive }
}

const cachedPreview: MobileSessionTabStripPreview = {
  tabs: [
    { id: 'tab-1', type: 'terminal', title: 'claude', agentId: 'claude' },
    { id: 'tab-2', type: 'terminal', title: 'shell', agentId: null }
  ],
  activeTabId: 'tab-1'
}

const base = {
  connState: 'reconnecting',
  verdictKind: 'normal',
  terminalsLoaded: false,
  liveTabCount: 0,
  activeHandle: null,
  cachedPreview: null
} as const

describe('selectMobileSessionReconnectViewState', () => {
  it('renders the cached strip with a progress label while reconnecting', () => {
    const state = selectMobileSessionReconnectViewState({ ...base, cachedPreview })

    expect(state).toEqual({
      kind: 'reconnecting-with-cache',
      preview: cachedPreview,
      label: 'Reconnecting…'
    })
  })

  it('labels the post-connect hydration gap as loading, not reconnecting', () => {
    const state = selectMobileSessionReconnectViewState({
      ...base,
      connState: 'connected',
      cachedPreview
    })

    expect(state.kind === 'reconnecting-with-cache' && state.label).toBe('Loading tabs…')
  })

  it('blocks when nothing is cached for this workspace', () => {
    expect(selectMobileSessionReconnectViewState(base)).toEqual({ kind: 'blocking' })
    expect(
      selectMobileSessionReconnectViewState({
        ...base,
        cachedPreview: { tabs: [], activeTabId: null }
      })
    ).toEqual({ kind: 'blocking' })
  })

  it('keeps mounted live content instead of swapping in its own cached snapshot', () => {
    expect(
      selectMobileSessionReconnectViewState({ ...base, liveTabCount: 2, cachedPreview })
    ).toEqual({ kind: 'live' })
    expect(
      selectMobileSessionReconnectViewState({ ...base, activeHandle: 'h-1', cachedPreview })
    ).toEqual({ kind: 'live' })
  })

  it('treats a host-confirmed empty workspace as live', () => {
    expect(
      selectMobileSessionReconnectViewState({
        ...base,
        connState: 'connected',
        terminalsLoaded: true,
        cachedPreview
      })
    ).toEqual({ kind: 'live' })
  })

  it('falls back to the offline state once the retry loop or the pairing has failed', () => {
    expect(
      selectMobileSessionReconnectViewState({ ...base, verdictKind: 'unreachable', cachedPreview })
    ).toEqual({ kind: 'offline' })
    expect(
      selectMobileSessionReconnectViewState({ ...base, verdictKind: 'auth-failed', cachedPreview })
    ).toEqual({ kind: 'offline' })
  })

  it('keeps showing the cache through a transient warning verdict', () => {
    expect(
      selectMobileSessionReconnectViewState({ ...base, verdictKind: 'warning', cachedPreview }).kind
    ).toBe('reconnecting-with-cache')
  })
})

describe('getMobileSessionTabStripRows', () => {
  it('draws disabled preview rows while reconnecting, then the live tabs under the same keys', () => {
    const preview = selectMobileSessionReconnectViewState({ ...base, cachedPreview })
    const previewRows = getMobileSessionTabStripRows({
      liveTabs: [],
      activeSessionTabId: null,
      preview: preview.kind === 'reconnecting-with-cache' ? preview.preview : null
    })

    expect(previewRows.map((row) => row.entry.id)).toEqual(['tab-1', 'tab-2'])
    expect(previewRows.map((row) => row.tab)).toEqual([null, null])
    expect(previewRows.map((row) => row.isActive)).toEqual([true, false])

    const liveTabs = [terminalTab('tab-1', 'claude', true), terminalTab('tab-2', 'shell')]
    const liveRows = getMobileSessionTabStripRows({
      liveTabs,
      activeSessionTabId: 'tab-1',
      preview: null
    })

    expect(liveRows.map((row) => row.entry.id)).toEqual(previewRows.map((row) => row.entry.id))
    expect(liveRows.map((row) => row.isActive)).toEqual(previewRows.map((row) => row.isActive))
    expect(liveRows.every((row) => row.tab !== null)).toBe(true)
  })

  it('prefers live tabs over a preview that is still present', () => {
    const rows = getMobileSessionTabStripRows({
      liveTabs: [terminalTab('tab-9', 'fresh', true)],
      activeSessionTabId: 'tab-9',
      preview: cachedPreview
    })

    expect(rows.map((row) => row.entry.id)).toEqual(['tab-9'])
  })

  it('keeps only the drawn fields when projecting a preview to persist', () => {
    const preview = toMobileSessionTabStripPreview(
      [
        {
          type: 'terminal',
          id: 'tab-1',
          title: 'claude',
          terminal: 'h-1',
          launchAgent: 'claude',
          launchDraft: 'unsent secret prompt',
          isActive: true
        }
      ],
      'tab-1'
    )

    expect(preview).toEqual({
      tabs: [{ id: 'tab-1', type: 'terminal', title: 'claude', agentId: 'claude' }],
      activeTabId: 'tab-1'
    })
    expect(JSON.stringify(preview)).not.toContain('unsent secret prompt')
  })
})
