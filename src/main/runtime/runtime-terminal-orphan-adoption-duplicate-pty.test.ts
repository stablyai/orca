import { describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalOrphanAdoptionRequest
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  GIT_KEY,
  addWorkspace,
  emptySession,
  leaf
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { planDuplicatePtyPaneRepair } from '../persistence/terminal-topology/duplicate-pty-pane-repair'
import { adoptRuntimeTerminalOrphansFromInventory } from './runtime-terminal-orphan-adoption'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

const TAB = 'tab-1'
const KEPT = leaf(1)
const DUPLICATE = leaf(2)

function duplicateSession(): WorkspaceSessionState {
  const session = addWorkspace(emptySession(), GIT_KEY, [
    {
      id: 'group-1',
      tabs: [
        {
          id: TAB,
          leaves: [
            [KEPT, 'pty-1'],
            [DUPLICATE, 'pty-1']
          ]
        }
      ]
    }
  ])
  return { ...session, terminalPtyIncarnationsByPaneKey: { [`${TAB}:${KEPT}`]: 'inc-1' } }
}

function adoptKeptPane(session: WorkspaceSessionState) {
  const request: RuntimeTerminalOrphanAdoptionRequest = {
    worktree: GIT_KEY,
    expectedTopologyRevision: 0,
    claims: [
      { terminal: 'term-1', ptyId: 'pty-1', incarnationId: 'inc-1', tabId: TAB, leafId: KEPT }
    ]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: adoption reads only these PTY fields before the persisted-binding check.
  const pty = {
    ptyId: 'pty-1',
    incarnationId: 'inc-1',
    worktreeId: GIT_KEY,
    connectionId: null,
    connected: true,
    tabId: null,
    paneKey: null
  } as RuntimePtyWorktreeRecord
  const replayPersistedSurface = vi.fn()
  const adopted = adoptRuntimeTerminalOrphansFromInventory({
    hostId: LOCAL_EXECUTION_HOST_ID,
    request,
    workspace: {
      id: GIT_KEY,
      path: '/Users/dev/orca',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    },
    inventory: {
      livePtyIds: new Set(['pty-1']),
      allLivePtyIds: new Set(['pty-1']),
      terminalIdentityByPtyId: new Map([
        ['pty-1', { handle: 'term-1', incarnationId: 'inc-1', wslDistro: null }]
      ]),
      queriedHostIds: new Set([LOCAL_EXECUTION_HOST_ID])
    },
    repoId: 'repo-1',
    worktreeWslDistro: null,
    ports: {
      readSession: () => ({ session, sessionWorktreeId: GIT_KEY, currentRevision: 0 }),
      getPty: () => pty,
      getLeaves: () => [],
      getLeaf: () => undefined,
      getDisplayTitle: () => null,
      replayPersistedSurface,
      recordAdoptedSurface: vi.fn(),
      getMobileSnapshots: () => [],
      getSession: () => session,
      setSession: vi.fn(),
      flushSession: async () => {},
      hydrateSession: vi.fn(),
      notifySessionChanged: vi.fn(),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the replay path returns this value untouched.
      getSnapshot: () => ({}) as RuntimeMobileSessionTabsResult
    }
  })
  return { adopted, replayPersistedSurface }
}

describe('orphan adoption of a terminal main repaired at load', () => {
  it('refuses the stored duplicate as a competing owner (the reader that skips the Loader)', async () => {
    await expect(adoptKeptPane(duplicateSession()).adopted).rejects.toThrow(
      'terminal_orphan_competing_owner'
    )
  })

  it('replays the kept pane once the stored tree holds one pane per terminal', async () => {
    const repaired = planDuplicatePtyPaneRepair(duplicateSession())!.session
    const { adopted, replayPersistedSurface } = adoptKeptPane(repaired)

    await expect(adopted).resolves.toMatchObject({ adopted: false })
    expect(replayPersistedSurface).toHaveBeenCalledWith(expect.anything(), TAB, `${TAB}:${KEPT}`)
  })
})
