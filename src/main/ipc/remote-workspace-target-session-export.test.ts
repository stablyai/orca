import { describe, expect, it } from 'vitest'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/repo-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { createRepoRowExecutionHostLookup } from '../../shared/worktree-execution-host-resolution'
import {
  createWorktreeOwnerResolver,
  persistedSessionForTarget
} from './remote-workspace-target-session-export'

const TARGET_ID = 'target-1'
const WORKTREE_ID = 'repo-1::/remote/repo'

function tab(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: WORKTREE_ID,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function session(tabs: TerminalTab[]): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), tabsByWorktree: { [WORKTREE_ID]: tabs } }
}

describe('persistedSessionForTarget', () => {
  it("publishes the ssh partition's tabs, not a stray local copy of an SSH-owned workspace", () => {
    const partitions: Record<string, WorkspaceSessionState> = {
      local: session([tab('tab-stale')]),
      [`ssh:${TARGET_ID}`]: session([tab('tab-live')])
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the publish fallback reads only getWorkspaceSession.
    const store = {
      getWorkspaceSession: (hostId?: string) => partitions[hostId ?? 'local']
    } as unknown as Store
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ownership resolution reads only id, connectionId and executionHostId.
    const repos = [{ id: 'repo-1', connectionId: TARGET_ID, executionHostId: null }] as Repo[]

    const published = persistedSessionForTarget(
      store,
      TARGET_ID,
      createWorktreeOwnerResolver(createRepoRowExecutionHostLookup(repos))
    )

    expect(published.tabsByWorktree[WORKTREE_ID]?.map((entry) => entry.id)).toEqual(['tab-live'])
  })
})
