// Adopt local terminal tabs older builds spilled into runtime partitions; preserve server/SSH ownership (#18202).
import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { normalizeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { loadWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/workspace-layout-minted-ids'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { composeMainTerminalSurfaces, TerminalSurfaceIndex } from './terminal-surface-index'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const GIT = 'repo::/worktree'
const FOLDER = 'folder:notes'
const SSH_WORKTREE = 'remote-repo::/srv/app'
const SERVER_WORKTREE = 'server-repo::/home/app'
const LEAF = '11111111-1111-4111-8111-111111111111'
const SPILL: ExecutionHostId = 'runtime:env-1'

/** A session holding one single-pane terminal tab per [worktree, tab, terminal]. */
function session(tabs: readonly [worktreeId: string, tabId: string, ptyId: string][]) {
  const state: WorkspaceSessionState = { ...getDefaultWorkspaceSession() }
  for (const [worktreeId, tabId, ptyId] of tabs) {
    state.tabsByWorktree = {
      ...state.tabsByWorktree,
      [worktreeId]: [
        ...(state.tabsByWorktree[worktreeId] ?? []),
        {
          id: tabId,
          ptyId,
          worktreeId,
          title: tabId,
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
    state.terminalLayoutsByTabId = {
      ...state.terminalLayoutsByTabId,
      [tabId]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: ptyId }
      }
    }
  }
  return state
}

function indexOf(
  partitions: Partial<Record<ExecutionHostId, WorkspaceSessionState>>,
  homes: Record<string, ExecutionHostId>
) {
  const loaded = new Map<ExecutionHostId, ReturnType<typeof loadWorkspaceLayout>>()
  for (const [key, state] of Object.entries(partitions)) {
    const hostId = normalizeExecutionHostId(key)
    if (hostId && state) {
      loaded.set(hostId, loadWorkspaceLayout(hostId, state, nameBasedLoadContext()))
    }
  }
  return new TerminalSurfaceIndex({
    reads: () => ({
      readPartition: (hostId) => loaded.get(hostId) ?? null,
      onLayoutOperationCommitted: () => () => {}
    }),
    hostIds: () => [...loaded.keys()],
    homeHostId: (key) => homes[key] ?? null,
    generatedTitlesEnabled: () => false,
    onChanged: () => {}
  })
}

const panes = (index: TerminalSurfaceIndex) =>
  index
    .surfaces()
    .leaves.map((leaf) => `${leaf.worktreeId} ${leaf.tabId} ${leaf.ptyId}`)
    .sort()

describe('a local workspace’s tabs in a paired server’s partition (switch on)', () => {
  it.each([
    ['a git worktree', GIT],
    ['a folder workspace', FOLDER]
  ])('are main’s panes for %s', (_name, worktreeId) => {
    const index = indexOf(
      {
        local: session([[worktreeId, 'tab-local', 'pty-local']]),
        [SPILL]: session([[worktreeId, 'tab-spilled', 'pty-spilled']])
      },
      { [worktreeId]: 'local' }
    )

    expect(panes(index)).toEqual([
      `${worktreeId} tab-local pty-local`,
      `${worktreeId} tab-spilled pty-spilled`
    ])
  })

  it('are indexed once, from the local partition, when it holds the tab too', () => {
    const index = indexOf(
      {
        local: session([[GIT, 'tab-both', 'pty-local']]),
        [SPILL]: session([[GIT, 'tab-both', 'pty-spilled']])
      },
      { [GIT]: 'local' }
    )

    expect(panes(index)).toEqual([`${GIT} tab-both pty-local`])
  })

  it('give a terminal bound in both partitions exactly one pane, the local one', () => {
    const index = indexOf(
      {
        local: session([[GIT, 'tab-local', 'pty-both']]),
        [SPILL]: session([[GIT, 'tab-spilled', 'pty-both']])
      },
      { [GIT]: 'local' }
    )

    expect(panes(index)).toEqual([`${GIT} tab-local pty-both`])
  })

  it('leave an SSH workspace’s spilled tabs out, as today: its terminals run on the relay', () => {
    const index = indexOf(
      {
        'ssh:target': session([[SSH_WORKTREE, 'tab-ssh', 'pty-ssh']]),
        [SPILL]: session([[SSH_WORKTREE, 'tab-spilled', 'pty-spilled']])
      },
      { [SSH_WORKTREE]: 'ssh:target' }
    )

    expect(panes(index)).toEqual([`${SSH_WORKTREE} tab-ssh pty-ssh`])
  })

  it('leave a paired server’s own workspace to the window, as today', () => {
    const index = indexOf(
      { local: session([]), [SPILL]: session([[SERVER_WORKTREE, 'tab-server', 'pty-server']]) },
      { [SERVER_WORKTREE]: SPILL }
    )

    expect(panes(index)).toEqual([])
    expect(index.surfaces().worktreeIds.has(SERVER_WORKTREE)).toBe(false)
  })

  // Paired-server terminals remain mirrored server panes even when saved under a local workspace.
  it('leave a tab bound to a terminal a paired server runs to the window', () => {
    const remote = toRemoteRuntimePtyId('term_on_host', 'env-1')
    const index = indexOf(
      {
        local: session([[GIT, 'tab-local', 'pty-local']]),
        [SPILL]: session([[GIT, 'tab-worker', remote]])
      },
      { [GIT]: 'local' }
    )

    expect(panes(index)).toEqual([`${GIT} tab-local pty-local`])
  })
})

describe('a pane main holds whose terminal a paired server runs (switch on)', () => {
  it('keeps its binding though the terminal never registers on this host', () => {
    const remote = toRemoteRuntimePtyId('term_on_host', 'env-1')
    const index = indexOf({ local: session([[GIT, 'tab-worker', remote]]) }, { [GIT]: 'local' })

    const composed = composeMainTerminalSurfaces(
      { tabs: [], leaves: [] },
      index.surfaces(),
      () => null
    )

    expect(composed.leaves.map((leaf) => leaf.ptyId)).toEqual([remote])
  })
})
