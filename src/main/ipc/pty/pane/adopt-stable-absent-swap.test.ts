import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { SessionNotFoundError } from '../../../daemon/protocol/daemon-errors'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import type { Store } from '../../../persistence/loading-store/store'
import { getLocalPtyProvider, setLocalPtyProvider } from '../provider/registry'
import { adoptStablePane } from './adopt-stable'
import type { PaneSpawnOperation } from './pane-spawn-operation'
import type { ReplacedPaneOwner } from './replaced-pane-owner'

const WORKTREE_ID = 'repo-1::/workspace'
const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const DEAD_PTY_ID = 'dead-pty'

function sessionBoundTo(ptyId: string): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          worktreeId: WORKTREE_ID,
          ptyId,
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
        ptyIdsByLeafId: { [LEAF_ID]: ptyId }
      }
    }
  }
}

describe('a pane whose terminal the host no longer has', () => {
  const original = getLocalPtyProvider()
  afterEach(() => setLocalPtyProvider(original))

  // After a terminal service restart main starts the pane afresh; its start must swap the dead
  // binding in one write, or the pane is shown with no terminal in between.
  it('hands the fresh start the dead binding it swaps', async () => {
    const session = sessionBoundTo(DEAD_PTY_ID)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: adoption reads only the session.
    const store = { getWorkspaceSession: () => session } as unknown as Store
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the attach-only probe is the only call.
    setLocalPtyProvider({
      spawn: async () => {
        throw new SessionNotFoundError(DEAD_PTY_ID)
      }
    } as unknown as IPtyProvider)
    let kept: ReplacedPaneOwner | undefined
    let freshOperation: PaneSpawnOperation | undefined

    const adopted = await adoptStablePane(undefined, store, {
      cols: 80,
      rows: 24,
      worktreeId: WORKTREE_ID,
      tabId: TAB_ID,
      leafId: LEAF_ID,
      keepAbsentBinding: (dead) => {
        kept = dead
      },
      spawnFresh: async (operation) => {
        freshOperation = operation
        return { id: DEAD_PTY_ID }
      }
    })

    expect(adopted).toBeNull()
    expect(kept?.ptyId).toBe(DEAD_PTY_ID)
    expect(freshOperation?.replacedOwner).toBe(kept)
  })
})
