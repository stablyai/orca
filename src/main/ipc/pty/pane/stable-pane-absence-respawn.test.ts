import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPaneBindingStore } from '../pty-launch-race-test-fixture'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import {
  SessionNotFoundError,
  TerminalSessionOwnerUnverifiedError
} from '../../../daemon/daemon-errors'
import type { Store } from '../../../persistence/loading-store/store'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import * as providers from '../provider/registry'
import { adoptStablePane } from './adopt-stable'
import type { StablePaneOwner } from './stable-owner'

import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'

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
  run: () => ReturnType<typeof adoptStablePane>
  spawn: ReturnType<typeof vi.fn>
} {
  const spawn = vi
    .fn()
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce({ id: 'ssh:conn-1@@pty-2', isReattach: false })
  const provider = new LocalPtyProvider()
  vi.spyOn(provider, 'spawn').mockImplementation(spawn)
  vi.spyOn(providers, 'getProvider').mockReturnValue(provider)
  const store = persistence?.store ?? sessionStore([LEAF]).store
  return {
    spawn,
    run: () =>
      adoptStablePane(undefined, store, {
        ...OWNER,
        worktreeId: WORKTREE,
        connectionId: 'conn-1',
        cols: 80,
        rows: 24,
        spawnFresh: () => spawn({ cols: 80, rows: 24 })
      })
  }
}

/** Real binding retirement against an in-memory session. */
function sessionStore(leaves: string[]): { store: Store; read: () => WorkspaceSessionState } {
  const store = createPaneBindingStore()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the legacy split fixture supplies the topology and binding fields read by adoption and retirement.
  const session = {
    ...store.getWorkspaceSession(),
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
  store.setWorkspaceSession(session)
  return {
    read: store.getWorkspaceSession,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared fixture implements durable pane admission, binding and retirement.
    store: store as unknown as Store
  }
}

describe('stable pane adoption after the owning host reports the PTY absent', () => {
  beforeEach(() => {
    for (const id of [OWNER.ptyId, 'ssh:conn-1@@pty-2']) {
      ptyOwnership.set(id, 'ssh:conn-1')
    }
  })
  afterEach(() => {
    for (const id of [OWNER.ptyId, 'ssh:conn-1@@pty-2']) {
      ptyOwnership.delete(id)
      ptyIncarnationById.delete(id)
    }
  })

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
      const provider = new LocalPtyProvider()
      vi.spyOn(provider, 'spawn').mockImplementation(spawn)
      vi.spyOn(providers, 'getProvider').mockReturnValue(provider)
      const result = await adoptStablePane(undefined, store, {
        ...OWNER,
        worktreeId: WORKTREE,
        connectionId: 'conn-1',
        cols: 80,
        rows: 24,
        spawnFresh: onFreshSpawn
      })
      expect(result?.owner).toMatchObject(OWNER)
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
    expect(result).toBeNull()
  })

  it('refuses to respawn a workspace pane when no Store can clear its binding', async () => {
    const spawn = vi.fn()
    const provider = new LocalPtyProvider()
    vi.spyOn(provider, 'spawn').mockRejectedValueOnce(new SessionNotFoundError(OWNER.ptyId))
    vi.spyOn(providers, 'getProvider').mockReturnValue(provider)
    const runtime = new OrcaRuntimeService()
    runtime.registerPty(OWNER.ptyId, WORKTREE, 'conn-1', OWNER)
    await expect(
      adoptStablePane(runtime, undefined, {
        ...OWNER,
        worktreeId: WORKTREE,
        connectionId: 'conn-1',
        cols: 80,
        rows: 24,
        spawnFresh: spawn
      })
    ).rejects.toThrow('terminal_pane_owner_changed')
    expect(spawn).not.toHaveBeenCalled()
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

  // Reach real binding retirement; a store-less fixture would miss regressions that delete the parent tab.
  describe('with persistence actually reached', () => {
    it("clears only the absent leaf's binding and leaves the tab and its sibling bound", async () => {
      const { store, read } = sessionStore([LEAF, SIBLING_LEAF])
      const { run, spawn } = spawnAfterAttachRejection(new SessionNotFoundError(OWNER.ptyId), {
        store,
        worktreeId: WORKTREE
      })

      const result = await run()

      expect(spawn).toHaveBeenCalledTimes(2)
      expect(result).toBeNull()
      const session = read()
      expect(session.tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual(['tab-1'])
      const layout = session.terminalLayoutsByTabId['tab-1']
      expect(layout).toBeDefined()
      expect(layout?.ptyIdsByLeafId?.[SIBLING_LEAF]).toBe('ssh:conn-1@@pty-2')
      expect(layout?.ptyIdsByLeafId?.[LEAF]).toBeUndefined()
    })

    // Replacing the only leaf must keep its tab/group/layout; otherwise main loses the tab bar.
    it('keeps the tab and its pane when the absent leaf was the only one', async () => {
      const { store, read } = sessionStore([LEAF])
      const { run, spawn } = spawnAfterAttachRejection(new SessionNotFoundError(OWNER.ptyId), {
        store,
        worktreeId: WORKTREE
      })

      const result = await run()

      expect(spawn).toHaveBeenCalledTimes(2)
      expect(result).toBeNull()
      const session = read()
      expect(session.tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual(['tab-1'])
      expect(session.terminalLayoutsByTabId['tab-1']?.root).toEqual({ type: 'leaf', leafId: LEAF })
      expect(session.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF]).toBeUndefined()
    })

    it('keeps the absent binding for the swap when the spawn takes it', async () => {
      const { store, read } = sessionStore([LEAF, SIBLING_LEAF])
      const before = JSON.stringify(read())
      const spawn = vi
        .fn()
        .mockRejectedValueOnce(new SessionNotFoundError(OWNER.ptyId))
        .mockResolvedValueOnce({ id: 'ssh:conn-1@@pty-3', isReattach: false })
      const provider = new LocalPtyProvider()
      vi.spyOn(provider, 'spawn').mockImplementation(spawn)
      vi.spyOn(providers, 'getProvider').mockReturnValue(provider)
      const keepAbsentBinding = vi.fn()

      const result = await adoptStablePane(undefined, store, {
        ...OWNER,
        worktreeId: WORKTREE,
        connectionId: 'conn-1',
        cols: 80,
        rows: 24,
        keepAbsentBinding,
        spawnFresh: () => spawn({ cols: 80, rows: 24 })
      })

      expect(result).toBeNull()
      expect(spawn).toHaveBeenCalledTimes(2)
      expect(keepAbsentBinding).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          ptyId: OWNER.ptyId,
          pane: { worktreeId: WORKTREE, tabId: 'tab-1', leafId: LEAF, hostId: 'ssh:conn-1' },
          dropsIncarnation: true
        })
      )
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
