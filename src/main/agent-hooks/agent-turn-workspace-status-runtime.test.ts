import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  WORKSPACE_STATUS_IN_REVIEW_ID,
  cloneDefaultWorkspaceStatuses
} from '../../shared/workspace-statuses'
import type { WorkspaceStatus } from '../../shared/worktree/types'

// Why only these fields: the binding reads exactly this projection of the wire row, so the
// fixture stays anchored to the real payload type without carrying its unrelated required fields.
type SnapshotRow = Pick<
  AgentStatusIpcPayload,
  'paneKey' | 'worktreeId' | 'state' | 'mainAgent' | 'providerSessionOnly'
>

const { statusSnapshotRows }: { statusSnapshotRows: { current: SnapshotRow[] } } = vi.hoisted(
  () => ({
    statusSnapshotRows: { current: [] }
  })
)

// Why the mock: the binding test proves which host the write lands on, not the hook server's row store.
vi.mock('./server', () => ({
  agentHookServer: { getStatusSnapshot: () => statusSnapshotRows.current }
}))

import { agentTurnWorkspaceStatusDeps } from './agent-turn-workspace-status-runtime'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

const GIT_WORKTREE_ID = 'repo1::/repo/wt'
const FOLDER_WORKSPACE_ID = 'folder-workspace-1'
const FOLDER_WORKTREE_ID = `folder:${FOLDER_WORKSPACE_ID}`

type HostWrite = { selector?: string; folderId?: string; workspaceStatus?: WorkspaceStatus }

type RuntimeHost = Pick<
  OrcaRuntimeService,
  'updateManagedWorktreeMeta' | 'notifyFolderWorkspaceChanged'
>

function makeHarness(options: { enabled?: boolean; worktreeStatus?: WorkspaceStatus } = {}) {
  const writes: HostWrite[] = []
  const ui = {
    syncWorkspaceStatusFromAgentTurns: options.enabled === true,
    workspaceStatuses: cloneDefaultWorkspaceStatuses()
  }
  const storeFake = {
    getUI: () => ui,
    getWorktreeIdForTab: (tabId: string) => `repo1::/repo/${tabId}`,
    getWorktreeMeta: () => ({ workspaceStatus: options.worktreeStatus }),
    getFolderWorkspace: () => ({ workspaceStatus: 'todo' }),
    updateFolderWorkspace: (id: string, patch: { workspaceStatus: WorkspaceStatus }) => {
      writes.push({ folderId: id, ...patch })
    }
  }
  const runtimeFake = {
    updateManagedWorktreeMeta: async (
      selector: string,
      patch: { workspaceStatus: WorkspaceStatus }
    ) => {
      writes.push({ selector, ...patch })
    },
    notifyFolderWorkspaceChanged: () => {
      writes.push({ folderId: `${FOLDER_WORKSPACE_ID}:notified` })
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements only the five methods this binding reads; no real Store is constructed here.
  const store = storeFake as unknown as Store
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both members are recorder stubs whose patch type is narrower than the real runtime's; the fake replaces the whole Pick.
  const runtime = runtimeFake as unknown as RuntimeHost
  return { deps: agentTurnWorkspaceStatusDeps(store, runtime), writes }
}

beforeEach(() => {
  statusSnapshotRows.current = []
})

describe('agentTurnWorkspaceStatusDeps', () => {
  it('follows the persisted opt-in', () => {
    expect(makeHarness().deps.isEnabled()).toBe(false)
    expect(makeHarness({ enabled: true }).deps.isEnabled()).toBe(true)
  })

  it('resolves the workspace from the tab map rather than the id the agent echoed', () => {
    expect(makeHarness().deps.resolveWorktreeIdForTab('wt')).toBe(GIT_WORKTREE_ID)
  })

  it('falls back to the default column when the workspace has no stored status', () => {
    expect(makeHarness().deps.getWorkspaceStatus(GIT_WORKTREE_ID)).toBe('in-progress')
    expect(
      makeHarness({ worktreeStatus: WORKSPACE_STATUS_IN_REVIEW_ID }).deps.getWorkspaceStatus(
        GIT_WORKTREE_ID
      )
    ).toBe(WORKSPACE_STATUS_IN_REVIEW_ID)
  })

  it('writes a git worktree through the runtime selector', async () => {
    const { deps, writes } = makeHarness({ enabled: true })
    await deps.setWorkspaceStatus(GIT_WORKTREE_ID, WORKSPACE_STATUS_IN_REVIEW_ID)
    expect(writes).toEqual([{ selector: `id:${GIT_WORKTREE_ID}`, workspaceStatus: 'in-review' }])
  })

  it('writes a folder workspace to the folder store and notifies, since the runtime selector cannot address it', async () => {
    const { deps, writes } = makeHarness({ enabled: true })
    await deps.setWorkspaceStatus(FOLDER_WORKTREE_ID, WORKSPACE_STATUS_IN_REVIEW_ID)
    expect(writes).toEqual([
      { folderId: FOLDER_WORKSPACE_ID, workspaceStatus: 'in-review' },
      { folderId: `${FOLDER_WORKSPACE_ID}:notified` }
    ])
  })

  it('reads the lead state of each live pane and skips identity-only rows', () => {
    statusSnapshotRows.current = [
      {
        paneKey: 'a:0',
        worktreeId: GIT_WORKTREE_ID,
        state: 'working',
        mainAgent: { state: 'done', stateStartedAt: 1 }
      },
      { paneKey: 'b:0', worktreeId: GIT_WORKTREE_ID, state: 'working', providerSessionOnly: true }
    ]
    const panes = makeHarness().deps.getLivePanes()
    expect(panes).toEqual([{ paneKey: 'a:0', worktreeId: GIT_WORKTREE_ID, state: 'done' }])
  })
})
