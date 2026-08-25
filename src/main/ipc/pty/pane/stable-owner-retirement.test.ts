import { describe, expect, it, vi } from 'vitest'
import type { TerminalOwnerIdentity } from '../../../../shared/terminal-owner-identity'
import { TerminalSessionExitedError } from '../../../daemon/daemon-errors'
import { attachStablePaneOwner } from './stable-owner-attach'
import { retirePersistedStablePaneOwner, type StablePaneOwner } from './stable-owner'

const worktreeId = 'repo-1::/tmp/owner-retirement'
const tabId = 'tab-owner-retirement'
const leafId = '11111111-1111-4111-8111-111111111111'
const paneKey = `${tabId}:${leafId}`

function ownerIdentity(ownerIncarnationId: string): TerminalOwnerIdentity {
  return {
    executionHostId: 'local',
    ownerKind: 'daemon',
    ownerIncarnationId,
    sessionIncarnationId: 'session-a',
    protocolVersion: 37,
    endpointRef: 'daemon-v37'
  }
}

function session(identity = ownerIdentity('daemon-a')) {
  return {
    tabsByWorktree: {
      [worktreeId]: [{ id: tabId, worktreeId, ptyId: 'pty-a' }]
    },
    terminalLayoutsByTabId: {
      [tabId]: {
        root: { type: 'leaf' as const, leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: 'pty-a' }
      }
    },
    terminalPtyIncarnationsByPaneKey: { [paneKey]: 'session-a' },
    terminalPtyOwnersByPaneKey: { [paneKey]: identity },
    terminalTopologyRevisionByRepoId: {}
  }
}

function stableOwner(): StablePaneOwner {
  return {
    tabId,
    leafId,
    ptyId: 'pty-a',
    incarnationId: 'session-a',
    persistedIncarnationId: 'session-a',
    hasPersistedBinding: true,
    ownerIdentity: ownerIdentity('daemon-a')
  }
}

describe('stable pane owner retirement', () => {
  it('rejects a replacement owner even when logical and session ids match', () => {
    const currentSession = session(ownerIdentity('daemon-b'))
    const store = {
      getWorkspaceSession: vi.fn(() => currentSession),
      setWorkspaceSession: vi.fn(),
      flushOrThrow: vi.fn()
    }

    expect(retirePersistedStablePaneOwner(store as never, stableOwner(), worktreeId, null)).toBe(
      false
    )
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
    expect(store.flushOrThrow).not.toHaveBeenCalled()
  })

  it('commits the persisted owner retirement before clearing runtime state', async () => {
    const order: string[] = []
    let currentSession = session()
    const store = {
      getWorkspaceSession: vi.fn(() => currentSession),
      setWorkspaceSession: vi.fn((next) => {
        order.push('persist')
        currentSession = next
      }),
      flushOrThrow: vi.fn(() => order.push('flush'))
    }
    const runtime = {
      onPtyExit: vi.fn(() => order.push('runtime-exit'))
    }
    const provider = {
      spawn: vi.fn(async () => {
        throw new TerminalSessionExitedError('pty-a')
      })
    }

    await expect(
      attachStablePaneOwner({
        runtime: runtime as never,
        store: store as never,
        provider: provider as never,
        spawnOptions: { cols: 80, rows: 24 },
        owner: stableOwner(),
        worktreeId,
        connectionId: null
      })
    ).resolves.toBeNull()

    expect(order).toEqual(['persist', 'flush', 'runtime-exit'])
  })

  it('restores persisted topology and preserves runtime state when flush fails', async () => {
    const originalSession = session()
    let currentSession = originalSession
    const store = {
      getWorkspaceSession: vi.fn(() => currentSession),
      setWorkspaceSession: vi.fn((next) => {
        currentSession = next
      }),
      flushOrThrow: vi.fn(() => {
        throw new Error('disk unavailable')
      })
    }
    const runtime = { onPtyExit: vi.fn() }
    const provider = {
      spawn: vi.fn(async () => {
        throw new TerminalSessionExitedError('pty-a')
      })
    }

    await expect(
      attachStablePaneOwner({
        runtime: runtime as never,
        store: store as never,
        provider: provider as never,
        spawnOptions: { cols: 80, rows: 24 },
        owner: stableOwner(),
        worktreeId,
        connectionId: null
      })
    ).rejects.toThrow('disk unavailable')

    expect(currentSession).toBe(originalSession)
    expect(runtime.onPtyExit).not.toHaveBeenCalled()
  })
})
