import { describe, expect, it, vi } from 'vitest'
import { withDurableRuntimeStore } from '../../../runtime/runtime-durable-store-fixture'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import {
  SessionNotFoundError,
  TerminalSessionOwnerUnverifiedError
} from '../../../daemon/daemon-errors'
import type { Store } from '../../../persistence'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
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

/** Real binding retirement against an in-memory session. */
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies every persistence method used by stable-pane retirement.
    store: withDurableRuntimeStore({
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        session = next
      },
      flushOrThrow: () => {}
    }) as unknown as Store
  }
}

describe('stable pane adoption after the owning host reports the PTY absent', () => {
  it.each([false, true])(
    'reattaches a live pane without launching a provider process (settled worker: %s)',
    async (settledWorker) => {
      const { store, read } = sessionStore([LEAF])
      const paneKey = `${OWNER.tabId}:${LEAF}`
      const record = {
        paneKey,
        tabId: OWNER.tabId,
        worktreeId: WORKTREE,
        agent: 'claude' as const,
        providerSession: { key: 'session_id' as const, id: 'provider-session' },
        prompt: '',
        state: 'done' as const,
        capturedAt: 1,
        updatedAt: 1,
        ...(settledWorker ? { automaticResumeBlockedBy: 'legacy-orchestration-worker' } : {})
      }
      store.setWorkspaceSession({
        ...read(),
        sleepingAgentSessionsByPaneKey: { [paneKey]: record }
      })
      const spawn = vi.fn().mockResolvedValue({ id: OWNER.ptyId, isReattach: true })
      const onFreshSpawn = vi.fn()
      const result = await spawnForStablePane({
        runtime: undefined,
        store,
        worktreeId: WORKTREE,
        provider: { spawn } as unknown as IPtyProvider,
        spawnOptions: { cols: 80, rows: 24, command: 'claude --resume provider-session' },
        owner: OWNER,
        connectionId: 'conn-1',
        resolveOwner: () => OWNER,
        onFreshSpawn
      })
      expect(result.owner).toBe(OWNER)
      expect(spawn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionId: OWNER.ptyId, attachOnly: true, command: undefined })
      )
      expect(onFreshSpawn).not.toHaveBeenCalled()
      expect(read().tabsByWorktree[WORKTREE]).toHaveLength(1)
    }
  )

  it('spawns fresh once the owning host has positively answered for that id', async () => {
    const { run, spawn } = spawnAfterAttachRejection(new SessionNotFoundError(OWNER.ptyId))

    const result = await run()

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ attachOnly: true })
    expect(spawn.mock.calls[1]?.[0]).not.toHaveProperty('sessionId')
    expect(result.owner).toBeNull()
  })

  it('refuses to respawn a workspace pane when no Store can clear its binding', async () => {
    const spawn = vi.fn().mockRejectedValueOnce(new SessionNotFoundError(OWNER.ptyId))

    await expect(
      spawnForStablePane({
        runtime: undefined,
        provider: { spawn } as unknown as IPtyProvider,
        spawnOptions: { cols: 80, rows: 24 },
        owner: OWNER,
        worktreeId: WORKTREE,
        connectionId: 'conn-1',
        resolveOwner: () => null
      })
    ).rejects.toThrow('terminal_pane_owner_changed')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  // The message alone cannot distinguish absence from a lost link; only the class may authorise
  // abandoning the binding.
  it.each([
    ['an untyped absence message', `Session not found: ${OWNER.ptyId}`],
    ['a lost link', 'SSH connection lost, reconnecting...'],
    ['a request timeout', 'Request "pty.attach" timed out after 10000ms']
  ])('keeps the binding and refuses to respawn after %s', async (_label, message) => {
    const { run, spawn } = spawnAfterAttachRejection(new Error(message))

    await expect(run()).rejects.toThrow(message)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  // Why a real store: without one the `args.worktreeId` guard short-circuits and the retirement —
  // which once deleted the parent tab and its layout — never runs. "Reconnect lost every tab" is the
  // regression this subsystem was reverted for twice, so the composition needs its own coverage.
  describe('with persistence actually reached', () => {
    it("clears only the absent leaf's binding and leaves the tab and its sibling bound", async () => {
      const { store, read } = sessionStore([LEAF, SIBLING_LEAF])
      const { run, spawn } = spawnAfterAttachRejection(new SessionNotFoundError(OWNER.ptyId), {
        store,
        worktreeId: WORKTREE
      })

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

    // The fresh spawn takes the pane, so the tab, its group and the leaf all stay; only the dead
    // id is unbound. Dropping the tab here left main with no tab bar until the window saved again.
    it('keeps the tab and its pane when the absent leaf was the only one', async () => {
      const { store, read } = sessionStore([LEAF])
      const { run, spawn } = spawnAfterAttachRejection(new SessionNotFoundError(OWNER.ptyId), {
        store,
        worktreeId: WORKTREE
      })

      const result = await run()

      expect(spawn).toHaveBeenCalledTimes(2)
      expect(result.owner).toBeNull()
      const session = read()
      expect(session.tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual(['tab-1'])
      expect(session.terminalLayoutsByTabId['tab-1']?.root).toEqual({ type: 'leaf', leafId: LEAF })
      expect(session.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF]).toBeUndefined()
    })

    // A spawn holding the pane's reservation binds next: its bind swaps the dead id in one write.
    it('keeps the absent binding for the swap when the spawn takes it', async () => {
      const { store, read } = sessionStore([LEAF, SIBLING_LEAF])
      const before = JSON.stringify(read())
      const spawn = vi
        .fn()
        .mockRejectedValueOnce(new SessionNotFoundError(OWNER.ptyId))
        .mockResolvedValueOnce({ id: 'ssh:conn-1@@pty-3', isReattach: false })
      const keepAbsentBinding = vi.fn()

      const result = await spawnForStablePane({
        runtime: undefined,
        store,
        worktreeId: WORKTREE,
        provider: { spawn } as unknown as IPtyProvider,
        spawnOptions: { cols: 80, rows: 24 },
        owner: OWNER,
        connectionId: 'conn-1',
        // The persisted owner is still the dead id until the bind swaps it.
        resolveOwner: () => OWNER,
        keepAbsentBinding
      })

      expect(result.owner).toBeNull()
      expect(spawn).toHaveBeenCalledTimes(2)
      expect(keepAbsentBinding).toHaveBeenCalledExactlyOnceWith({
        ptyId: OWNER.ptyId,
        pane: { worktreeId: WORKTREE, tabId: 'tab-1', leafId: LEAF, hostId: 'ssh:conn-1' },
        dropsIncarnation: true
      })
      expect(JSON.stringify(read())).toBe(before)
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

    it('does not retire the binding when daemon attach-only cleanup is unverifiable', async () => {
      const { store, read } = sessionStore([LEAF, SIBLING_LEAF])
      const before = JSON.stringify(read())
      const { run, spawn } = spawnAfterAttachRejection(
        new TerminalSessionOwnerUnverifiedError(OWNER.ptyId),
        { store, worktreeId: WORKTREE }
      )

      await expect(run()).rejects.toThrow('terminal_pane_owner_unverified')

      expect(spawn).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(read())).toBe(before)
    })
  })
})
