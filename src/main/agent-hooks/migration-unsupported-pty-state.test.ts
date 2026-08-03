import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MigrationUnsupportedPtyEntry } from '../../shared/agent-status-types'
import {
  clearMigrationUnsupportedPty,
  clearMigrationUnsupportedPtysByTabPrefix,
  clearMigrationUnsupportedPtysForPaneKey,
  getMigrationUnsupportedPtySnapshot,
  setMigrationUnsupportedPty,
  setMigrationUnsupportedPtyListener,
  setMigrationUnsupportedPtyPersistenceListener
} from './migration-unsupported-pty-state'

function makeEntry(ptyId: string, paneKey: string): MigrationUnsupportedPtyEntry {
  return {
    ptyId,
    paneKey,
    tabId: paneKey.split(':')[0] ?? paneKey,
    worktreeId: 'wt-1',
    reason: 'legacy-numeric-pane-key',
    source: 'local',
    updatedAt: 1_000
  }
}

describe('migration unsupported PTY state', () => {
  afterEach(() => {
    setMigrationUnsupportedPtyListener(null)
    setMigrationUnsupportedPtyPersistenceListener(null)
    for (const entry of getMigrationUnsupportedPtySnapshot()) {
      clearMigrationUnsupportedPty(entry.ptyId)
    }
  })

  it('persists once when clearing multiple entries for one pane', () => {
    const listener = vi.fn()
    const persist = vi.fn()
    setMigrationUnsupportedPtyListener(listener)
    setMigrationUnsupportedPtyPersistenceListener(persist)
    const first = makeEntry('pty-1', 'tab-1:leaf-a')
    const second = makeEntry('pty-2', 'tab-1:leaf-a')
    const otherPane = makeEntry('pty-3', 'tab-2:leaf-b')

    setMigrationUnsupportedPty(first)
    setMigrationUnsupportedPty(second)
    setMigrationUnsupportedPty(otherPane)
    listener.mockClear()
    persist.mockClear()

    clearMigrationUnsupportedPtysForPaneKey('tab-1:leaf-a')

    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenNthCalledWith(1, { type: 'clear', ptyId: 'pty-1' })
    expect(listener).toHaveBeenNthCalledWith(2, { type: 'clear', ptyId: 'pty-2' })
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledWith([otherPane])
  })

  it('persists once when clearing multiple entries under one tab prefix', () => {
    const listener = vi.fn()
    const persist = vi.fn()
    setMigrationUnsupportedPtyListener(listener)
    setMigrationUnsupportedPtyPersistenceListener(persist)
    const first = makeEntry('pty-1', 'tab-1:leaf-a')
    const second = makeEntry('pty-2', 'tab-1:leaf-b')
    const sibling = makeEntry('pty-3', 'tab-10:leaf-c')
    const otherTab = makeEntry('pty-4', 'tab-2:leaf-d')

    setMigrationUnsupportedPty(first)
    setMigrationUnsupportedPty(second)
    setMigrationUnsupportedPty(sibling)
    setMigrationUnsupportedPty(otherTab)
    listener.mockClear()
    persist.mockClear()

    clearMigrationUnsupportedPtysByTabPrefix('tab-1')

    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenNthCalledWith(1, { type: 'clear', ptyId: 'pty-1' })
    expect(listener).toHaveBeenNthCalledWith(2, { type: 'clear', ptyId: 'pty-2' })
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledWith([sibling, otherTab])
  })
})
