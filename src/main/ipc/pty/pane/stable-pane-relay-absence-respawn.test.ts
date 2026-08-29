import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import {
  SSH_SESSION_EXPIRED_ERROR,
  SshPtyAbsentFromRelayError
} from '../../../providers/ssh-pty-errors'
import type { Store } from '../../../persistence'
import type { IPtyProvider } from '../../../providers/types'
import { spawnForStablePane, type StablePaneOwner } from './stable-owner'

const LEAF = '1b3f2c4d-5e6a-4b7c-8d9e-0f1a2b3c4d5e'
const SIBLING_LEAF = '2c4d3e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f'
const WORKTREE = 'worktree-1'
const OWNER: StablePaneOwner = {
  tabId: 'tab-1',
  leafId: LEAF,
  ptyId: 'ssh:conn-1@@pty-1',
  hasPersistedBinding: true
}

function spawnAfterAttachRejection(
  error: unknown,
  persistence?: { store: Store; worktreeId: string }
): {
  run: () => ReturnType<typeof spawnForStablePane>
  spawn: ReturnType<typeof vi.fn>
} {
  const spawn = vi
    .fn()
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce({ id: 'ssh:conn-1@@pty-2', isReattach: false })
  return {
    spawn,
    run: () =>
      spawnForStablePane({
        runtime: undefined,
        provider: { spawn } as unknown as IPtyProvider,
        spawnOptions: { cols: 80, rows: 24 },
        owner: OWNER,
        connectionId: 'conn-1',
        resolveOwner: () => null,
        ...(persistence ? { store: persistence.store, worktreeId: persistence.worktreeId } : {})
      })
  }
}

/** Real retirement against an in-memory session, so `retireTerminalSurfaceFromPersistence` runs. */
function sessionStore(leaves: string[]): { store: Store; read: () => WorkspaceSessionState } {
  let session = {
    tabsByWorktree: {
      [WORKTREE]: [{ id: 'tab-1', worktreeId: WORKTREE, ptyId: 'ssh:conn-1@@pty-1' }]
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: leaves.reduce<Record<string, unknown>>(
          (node, leafId) =>
            Object.keys(node).length === 0
              ? { type: 'leaf', leafId }
              : { type: 'split', direction: 'row', first: node, second: { type: 'leaf', leafId } },
          {}
        ),
        activeLeafId: leaves[0],
        ptyIdsByLeafId: Object.fromEntries(
          leaves.map((leafId, index) => [leafId, `ssh:conn-1@@pty-${index + 1}`])
        )
      }
    },
    terminalPtyIncarnationsByPaneKey: {}
  } as unknown as WorkspaceSessionState
  return {
    read: () => session,
    store: {
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        session = next
      },
      flushOrThrow: () => {}
    } as unknown as Store
  }
}

describe('stable pane adoption after the relay reports the PTY absent', () => {
  it('spawns fresh once the relay has positively answered for that id', async () => {
    const { run, spawn } = spawnAfterAttachRejection(
      new SshPtyAbsentFromRelayError(`${SSH_SESSION_EXPIRED_ERROR}: pty-1`)
    )

    const result = await run()

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ attachOnly: true })
    expect(spawn.mock.calls[1]?.[0]).not.toHaveProperty('sessionId')
    expect(result.owner).toBeNull()
  })

  // A restarted relay renumbers from pty-1, so the message alone cannot distinguish absence from a
  // lost link — only the class may authorise abandoning the binding.
  it.each([
    ['an expired session with no relay evidence', `${SSH_SESSION_EXPIRED_ERROR}: pty-1`],
    ['a lost link', 'SSH connection lost, reconnecting...'],
    ['a request timeout', 'Request "pty.attach" timed out after 10000ms']
  ])('keeps the binding and refuses to respawn after %s', async (_label, message) => {
    const { run, spawn } = spawnAfterAttachRejection(new Error(message))

    await expect(run()).rejects.toThrow(message)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  // Why a real store: without one the `args.worktreeId` guard short-circuits and the retirement —
  // which can delete the parent tab and its layout — never runs. "Reconnect lost every tab" is the
  // regression this subsystem was reverted for twice, so the composition needs its own coverage.
  describe('with persistence actually reached', () => {
    it('retires only the absent leaf and leaves the tab and its sibling bound', async () => {
      const { store, read } = sessionStore([LEAF, SIBLING_LEAF])
      const { run, spawn } = spawnAfterAttachRejection(
        new SshPtyAbsentFromRelayError(`${SSH_SESSION_EXPIRED_ERROR}: pty-1`),
        { store, worktreeId: WORKTREE }
      )

      const result = await run()

      expect(spawn).toHaveBeenCalledTimes(2)
      expect(result.owner).toBeNull()
      const session = read()
      expect(session.tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual(['tab-1'])
      const layout = session.terminalLayoutsByTabId['tab-1']
      expect(layout).toBeDefined()
      expect(layout?.ptyIdsByLeafId?.[SIBLING_LEAF]).toBe('ssh:conn-1@@pty-2')
      expect(layout?.ptyIdsByLeafId?.[LEAF]).toBeUndefined()
    })

    // Pins current behaviour rather than blessing it: retiring the LAST leaf drops the tab from
    // persistence, and the fallback returns owner=null so main does not re-persist a binding — tab
    // survival then rests entirely on the renderer. If that ever regresses, this is the tripwire.
    it('drops the tab when the absent leaf was the only one, leaving re-persistence to the renderer', async () => {
      const { store, read } = sessionStore([LEAF])
      const { run, spawn } = spawnAfterAttachRejection(
        new SshPtyAbsentFromRelayError(`${SSH_SESSION_EXPIRED_ERROR}: pty-1`),
        { store, worktreeId: WORKTREE }
      )

      const result = await run()

      expect(spawn).toHaveBeenCalledTimes(2)
      expect(result.owner).toBeNull()
      const session = read()
      expect(session.tabsByWorktree[WORKTREE]).toEqual([])
      expect(session.terminalLayoutsByTabId['tab-1']).toBeUndefined()
    })

    it('leaves persistence untouched when the failure is not positive absence', async () => {
      const { store, read } = sessionStore([LEAF, SIBLING_LEAF])
      const before = JSON.stringify(read())
      const { run, spawn } = spawnAfterAttachRejection(
        new Error('SSH connection lost, reconnecting...'),
        { store, worktreeId: WORKTREE }
      )

      await expect(run()).rejects.toThrow('SSH connection lost')

      expect(spawn).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(read())).toBe(before)
    })
  })
})
