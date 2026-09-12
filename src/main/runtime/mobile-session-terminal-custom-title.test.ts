import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { buildHeadlessMobileSessionTerminalTabs } from './mobile-session-terminal-projection'
import { persistedCustomTitleMissingFromSnapshot } from './orca-runtime-hydrate-headless-mobile-session-tabs-from-workspace-session'
import type { RuntimeMobileSessionTerminalTab } from '../../shared/runtime-types'

function makePersistedTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'repo1::/path/wt1',
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function makeSession(tabs: TerminalTab[]): WorkspaceSessionState {
  return {
    tabsByWorktree: { 'repo1::/path/wt1': tabs }
  } as unknown as WorkspaceSessionState
}

describe('buildHeadlessMobileSessionTerminalTabs customTitle', () => {
  it('carries the persisted customTitle into the built tab', () => {
    const tabs = buildHeadlessMobileSessionTerminalTabs(
      'repo1::/path/wt1',
      [makePersistedTab({ customTitle: 'my rename' })],
      makeSession([])
    )
    expect(tabs).toHaveLength(1)
    expect(tabs[0]!.customTitle).toBe('my rename')
    // The resolved title already prefers the rename.
    expect(tabs[0]!.title).toBe('my rename')
  })

  it('omits customTitle when no rename is persisted', () => {
    const tabs = buildHeadlessMobileSessionTerminalTabs(
      'repo1::/path/wt1',
      [makePersistedTab()],
      makeSession([])
    )
    expect(tabs[0]!.customTitle).toBeUndefined()
  })

  it('clearing a rename (null customTitle) drops the field', () => {
    const tabs = buildHeadlessMobileSessionTerminalTabs(
      'repo1::/path/wt1',
      [makePersistedTab({ customTitle: null })],
      makeSession([])
    )
    expect(tabs[0]!.customTitle).toBeUndefined()
  })
})

function makeSnapshotTab(
  overrides: Partial<RuntimeMobileSessionTerminalTab> = {}
): RuntimeMobileSessionTerminalTab {
  return {
    type: 'terminal',
    id: 'tab-1::leaf-1',
    parentTabId: 'tab-1',
    leafId: 'leaf-1',
    title: 'Terminal',
    isActive: false,
    ...overrides
  }
}

describe('persistedCustomTitleMissingFromSnapshot', () => {
  it('flags a rename missing from the snapshot', () => {
    expect(
      persistedCustomTitleMissingFromSnapshot(
        [makePersistedTab({ customTitle: 'my rename' })],
        [makeSnapshotTab()]
      )
    ).toBe(true)
  })

  it('passes when the snapshot already carries the rename', () => {
    expect(
      persistedCustomTitleMissingFromSnapshot(
        [makePersistedTab({ customTitle: 'my rename' })],
        [makeSnapshotTab({ customTitle: 'my rename' })]
      )
    ).toBe(false)
  })

  it('flags a cleared rename (null persisted) still carried by the snapshot', () => {
    expect(
      persistedCustomTitleMissingFromSnapshot(
        [makePersistedTab({ customTitle: null })],
        [makeSnapshotTab({ customTitle: 'stale rename' })]
      )
    ).toBe(true)
  })

  it('passes when the rename is cleared on both sides', () => {
    expect(
      persistedCustomTitleMissingFromSnapshot(
        [makePersistedTab({ customTitle: null })],
        [makeSnapshotTab()]
      )
    ).toBe(false)
  })

  it('passes when nothing is persisted', () => {
    expect(persistedCustomTitleMissingFromSnapshot([makePersistedTab()], [makeSnapshotTab()])).toBe(
      false
    )
  })

  it('ignores tabs absent from the snapshot (handled by rebuild identity)', () => {
    expect(
      persistedCustomTitleMissingFromSnapshot(
        [makePersistedTab({ id: 'tab-other', customTitle: 'rename' })],
        [makeSnapshotTab()]
      )
    ).toBe(false)
  })
})
