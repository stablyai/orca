import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { SessionNotFoundError } from '../../../daemon/protocol/daemon-errors'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import type { Store } from '../../../persistence/loading-store/store'
import { getLocalPtyProvider, setLocalPtyProvider } from '../provider/registry'
import { adoptStablePane } from './adopt-stable'
import { takeReplacedPaneOwner, type PaneSpawnOperation } from './pane-spawn-operation'
import type { AdoptStablePaneArgs } from '../ipc/spawn-types'

const WORKTREE_ID = 'repo-1::/workspace'
const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const DEAD_PTY_ID = 'dead-pty'

// One pane whose stored binding names a terminal the host no longer has.
function deadBindingStore(): { store: Store; retired: string[] } {
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          worktreeId: WORKTREE_ID,
          ptyId: DEAD_PTY_ID,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: DEAD_PTY_ID }
      }
    }
  }
  const retired: string[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: adoption reads the session and retires bindings only.
  const store = {
    getWorkspaceSession: () => session,
    retirePtyBinding: async (pane: { ptyId: string }) => {
      retired.push(pane.ptyId)
      return true
    }
  } as unknown as Store
  return { store, retired }
}

function adopt(
  store: Store,
  spawnFresh: NonNullable<AdoptStablePaneArgs['spawnFresh']>,
  signal?: AbortSignal
) {
  return adoptStablePane(undefined, store, {
    cols: 80,
    rows: 24,
    worktreeId: WORKTREE_ID,
    tabId: TAB_ID,
    leafId: LEAF_ID,
    keepAbsentBinding: true,
    signal,
    spawnFresh
  })
}

describe('a pane whose terminal the host no longer has', () => {
  const original = getLocalPtyProvider()
  afterEach(() => setLocalPtyProvider(original))

  function hostWithoutTheTerminal(onProbe?: () => void): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the attach-only probe is the only call.
    setLocalPtyProvider({
      spawn: async () => {
        onProbe?.()
        throw new SessionNotFoundError(DEAD_PTY_ID)
      }
    } as unknown as IPtyProvider)
  }

  // After a terminal service restart main starts the pane afresh; its start must swap the dead
  // binding in one write, or the pane is shown with no terminal in between.
  it('hands the fresh start the dead binding it swaps', async () => {
    const { store, retired } = deadBindingStore()
    hostWithoutTheTerminal()
    let freshOperation: PaneSpawnOperation | undefined
    await adopt(store, async (operation) => {
      freshOperation = operation
      return { id: DEAD_PTY_ID }
    })
    expect(freshOperation?.replacedOwner?.ptyId).toBe(DEAD_PTY_ID)
    expect(retired).toEqual([])
  })

  it('retires the dead binding when the start is aborted before any spawn takes it', async () => {
    const { store, retired } = deadBindingStore()
    const abort = new AbortController()
    hostWithoutTheTerminal(() => abort.abort())
    let spawned = false
    await expect(
      adopt(
        store,
        async () => {
          spawned = true
          return { id: DEAD_PTY_ID }
        },
        abort.signal
      )
    ).rejects.toThrow('client_disconnected')
    expect(spawned).toBe(false)
    expect(retired).toEqual([DEAD_PTY_ID])
  })

  it('retires the dead binding when the launch fails before any spawn takes it', async () => {
    const { store, retired } = deadBindingStore()
    hostWithoutTheTerminal()
    await expect(
      adopt(store, async () => {
        throw new Error('launch_prepare_failed')
      })
    ).rejects.toThrow('launch_prepare_failed')
    expect(retired).toEqual([DEAD_PTY_ID])
  })

  it('leaves the dead binding to the spawn that took it', async () => {
    const { store, retired } = deadBindingStore()
    hostWithoutTheTerminal()
    await expect(
      adopt(store, async (operation) => {
        takeReplacedPaneOwner(operation)
        throw new Error('spawn_failed')
      })
    ).rejects.toThrow('spawn_failed')
    expect(retired).toEqual([])
  })
})
