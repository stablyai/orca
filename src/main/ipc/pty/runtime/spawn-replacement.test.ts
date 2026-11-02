import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../../../persistence/loading-store/store'
import { TEST_LEAF_1 } from '../../../persistence/persistence-session-fixtures'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import {
  makePaneSpawnReservationKey,
  paneSpawnReservationsByOwnerKey,
  rejectPaneSpawnReservation
} from '../pane/spawn-reservation'
import { ptyPaneKey } from '../pane/key-state'
import type { ReplacedPaneOwner } from '../pane/replaced-pane-owner'
import {
  beginRuntimePaneReplacement,
  isRuntimePaneBindRefusal,
  resolveRuntimeStablePaneOwner,
  runtimePaneBindingInput,
  runtimePaneBindRefusal
} from './spawn-replacement'

const worktreeId = 'repo-local::/fixture/local'
const tabId = 'restart-tab'
const paneKey = makePaneKey(tabId, TEST_LEAF_1)
const stopped: ReplacedPaneOwner = {
  ptyId: 'old',
  pane: { worktreeId, tabId, leafId: TEST_LEAF_1, hostId: undefined }
}

function storeBinding(ptyId: string): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the owner resolvers and swapReplacedPaneBinding read only getWorkspaceSession.
  return {
    getWorkspaceSession: () => ({
      tabsByWorktree: { [worktreeId]: [{ id: tabId, worktreeId }] },
      terminalLayoutsByTabId: { [tabId]: { ptyIdsByLeafId: { [TEST_LEAF_1]: ptyId } } },
      terminalPtyIncarnationsByPaneKey: {}
    })
  } as unknown as Store
}

function storeUnbound(): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the owner resolvers read only getWorkspaceSession.
  return {
    getWorkspaceSession: () => ({
      tabsByWorktree: { [worktreeId]: [{ id: tabId, worktreeId }] },
      terminalLayoutsByTabId: { [tabId]: { ptyIdsByLeafId: {} } },
      terminalPtyIncarnationsByPaneKey: {}
    })
  } as unknown as Store
}

function deps(store: Store) {
  return {
    runtime: undefined,
    store,
    getLocalPtyProviderStartupPromise: () => undefined,
    shutdownProviderAndDetectExit: vi.fn(async () => true),
    rememberSyntheticKillExit: vi.fn(),
    sendPtyExitToRenderer: vi.fn()
  }
}

afterEach(() => {
  ptyPaneKey.delete('old')
  for (const [key, reservation] of paneSpawnReservationsByOwnerKey) {
    rejectPaneSpawnReservation(key, reservation, new Error('test teardown'))
  }
})

describe('beginRuntimePaneReplacement', () => {
  it('refuses when another PTY owns the pane and stops nothing', async () => {
    const stop = vi.fn(async () => {})
    await expect(
      beginRuntimePaneReplacement(
        deps(storeBinding('successor')),
        { replacesPtyId: 'old', paneKey, worktreeId, connectionId: null },
        stop
      )
    ).rejects.toThrow('terminal_pane_owner_changed')
    expect(stop).not.toHaveBeenCalled()
    expect(paneSpawnReservationsByOwnerKey.size).toBe(0)
  })

  it('holds the pane, stops the owner and reports what it replaced', async () => {
    const stop = vi.fn(async () => {})
    const replacement = await beginRuntimePaneReplacement(
      deps(storeBinding('old')),
      { replacesPtyId: 'old', paneKey, worktreeId, connectionId: null },
      stop
    )
    expect(stop).toHaveBeenCalledWith('old')
    expect(replacement.reservationKey).toBe(makePaneSpawnReservationKey(worktreeId, null, paneKey))
    expect(paneSpawnReservationsByOwnerKey.get(replacement.reservationKey)).toBe(
      replacement.reservation
    )
    expect(replacement.replaced).toEqual(stopped)
  })

  it('needs a pane to replace into and stops nothing without one', async () => {
    const stop = vi.fn(async () => {})
    await expect(
      beginRuntimePaneReplacement(
        deps(storeBinding('old')),
        { replacesPtyId: 'old', paneKey: null, worktreeId, connectionId: null },
        stop
      )
    ).rejects.toThrow('terminal_pane_owner_unknown')
    expect(stop).not.toHaveBeenCalled()
    expect(paneSpawnReservationsByOwnerKey.size).toBe(0)
  })

  it("replaces an unbound pane's PTY when the id's own pane-key record proves it lives there", async () => {
    ptyPaneKey.set('old', paneKey)
    const stop = vi.fn(async () => {})
    const replacement = await beginRuntimePaneReplacement(
      deps(storeUnbound()),
      { replacesPtyId: 'old', paneKey, worktreeId, connectionId: null },
      stop
    )
    expect(stop).toHaveBeenCalledWith('old')
    expect(replacement.replaced).toEqual(stopped)
  })

  it('never stops an unproven id in an unbound pane: it refuses and releases the pane', async () => {
    ptyPaneKey.set('old', makePaneKey('other-tab', TEST_LEAF_1))
    const stop = vi.fn(async () => {})
    await expect(
      beginRuntimePaneReplacement(
        deps(storeUnbound()),
        { replacesPtyId: 'old', paneKey, worktreeId, connectionId: null },
        stop
      )
    ).rejects.toThrow('terminal_pane_owner_unknown')
    expect(stop).not.toHaveBeenCalled()
    expect(paneSpawnReservationsByOwnerKey.size).toBe(0)
    // The pane is free again for the next spawn.
    const next = await beginRuntimePaneReplacement(
      deps(storeBinding('old')),
      { replacesPtyId: 'old', paneKey, worktreeId, connectionId: null },
      stop
    )
    expect(next.replaced).toEqual(stopped)
  })
})

describe('resolveRuntimeStablePaneOwner', () => {
  it('never offers the stopped owner for reattach; any other spawn sees the bound owner', () => {
    const ctx = {
      deps: { runtime: undefined, store: storeBinding('old') },
      args: { worktreeId, connectionId: null },
      spawnIdentityPaneKey: paneKey
    }
    expect(resolveRuntimeStablePaneOwner({ ...ctx, replacedPaneOwner: stopped })).toBeNull()
    expect(resolveRuntimeStablePaneOwner({ ...ctx, replacedPaneOwner: null })).toMatchObject({
      ptyId: 'old',
      tabId,
      leafId: TEST_LEAF_1
    })
  })
})

describe('the runtime commit bind for a replacement', () => {
  const binding = { worktreeId, tabId, leafId: TEST_LEAF_1, ptyId: 'new', mayCreate: false }

  it('swaps only a leaf that still names the stopped id; a plain spawn binds as before', () => {
    expect(runtimePaneBindingInput(storeBinding('old'), binding, null)).toBe(binding)
    const swap = runtimePaneBindingInput(storeBinding('old'), binding, stopped)
    expect(typeof swap === 'function' ? swap() : swap).toBe(binding)
    const lost = runtimePaneBindingInput(storeBinding('successor'), binding, stopped)
    expect(typeof lost === 'function' ? lost() : lost).toBeNull()
  })

  it('throws the refusal that fits the spawn and rethrows either refusal as is', () => {
    expect(runtimePaneBindRefusal(stopped)).toBe('terminal_pane_owner_changed')
    expect(runtimePaneBindRefusal(null)).toBe('terminal_split_source_not_found')
    expect(isRuntimePaneBindRefusal(new Error('terminal_pane_owner_changed'))).toBe(true)
    expect(isRuntimePaneBindRefusal(new Error('terminal_split_source_not_found'))).toBe(true)
    expect(isRuntimePaneBindRefusal(new Error('disk full'))).toBe(false)
    expect(isRuntimePaneBindRefusal('terminal_pane_owner_changed')).toBe(false)
  })
})
