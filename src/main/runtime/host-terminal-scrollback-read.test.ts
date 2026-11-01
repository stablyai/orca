import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import { TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT } from '../../shared/terminal-scrollback-limits'
import {
  readHostTerminalScrollback,
  type HostTerminalScrollbackReadDeps
} from './host-terminal-scrollback-read'

const HELD_REF = `v1-${'a'.repeat(32)}`
const OTHER_WORKTREE_REF = `v1-${'b'.repeat(32)}`

function tab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function session(): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {
      'repo::/wt-a': [tab('tab-a', 'repo::/wt-a')],
      'repo::/wt-b': [tab('tab-b', 'repo::/wt-b')]
    },
    terminalLayoutsByTabId: {
      'tab-a': {
        root: { type: 'leaf', leafId: 'leaf-a' },
        activeLeafId: 'leaf-a',
        expandedLeafId: null,
        scrollbackRefsByLeafId: { 'leaf-a': HELD_REF }
      },
      'tab-b': {
        root: { type: 'leaf', leafId: 'leaf-b' },
        activeLeafId: 'leaf-b',
        expandedLeafId: null,
        scrollbackRefsByLeafId: { 'leaf-b': OTHER_WORKTREE_REF }
      }
    }
  }
}

function deps(overrides: Partial<HostTerminalScrollbackReadDeps> = {}) {
  const readSnapshot = vi.fn(async (ref: string) => (ref === HELD_REF ? 'stored history' : null))
  const statSnapshotSize = vi.fn(async (ref: string) => (ref === HELD_REF ? 14 : null))
  const resolved: HostTerminalScrollbackReadDeps = {
    resolveWorktreeId: async (selector) => {
      if (!selector.startsWith('id:')) {
        throw new Error('selector_not_found')
      }
      return selector.slice(3)
    },
    getWorkspaceSession: () => session(),
    statSnapshotSize,
    readSnapshot,
    ...overrides
  }
  return { resolved, readSnapshot }
}

describe('readHostTerminalScrollback', () => {
  it('refuses a ref named only by another worktree without touching the store', async () => {
    const { resolved, readSnapshot } = deps()
    await expect(
      readHostTerminalScrollback(resolved, {
        worktree: 'id:repo::/wt-a',
        ref: OTHER_WORKTREE_REF
      })
    ).rejects.toThrow('terminal_scrollback_not_found')
    expect(readSnapshot).not.toHaveBeenCalled()
  })

  it('refuses a file over the store limit before reading any of it', async () => {
    const { resolved, readSnapshot } = deps({
      statSnapshotSize: async () => TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT + 1
    })
    await expect(
      readHostTerminalScrollback(resolved, {
        worktree: 'id:repo::/wt-a',
        ref: HELD_REF
      })
    ).rejects.toThrow('terminal_scrollback_too_large')
    expect(readSnapshot).not.toHaveBeenCalled()
  })
})
