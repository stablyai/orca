// A windowless layout-owner runtime holding one terminal tab of a workspace main owns: its store
// applies layout commands in memory and tells write listeners, as main's terminal list relies on.
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'
import type { LayoutCommand } from '../../shared/workspace-layout/workspace-layout-command-types'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-session-contracts'
import { applyCommandToSession } from '../persistence/terminal-topology/terminal-pane-admission'
import { resolveHostId } from '../persistence/loading-store/session-host-partitions'
import { withDurableRuntimeStore, withRuntimePaneAdmission } from './runtime-durable-store-fixture'
import { OrcaRuntimeService } from './orca-runtime'

export const REPO = {
  id: 'repo-1',
  path: '/workspace',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1
}
export const WORKTREE_ID = 'repo-1::/workspace'
export const TAB_ID = 'tab-1'
export const LEAF_A = '11111111-1111-4111-8111-111111111111'
export const LEAF_B = '22222222-2222-4222-8222-222222222222'
export const PTY_A = 'pty-a'
export const PTY_B = 'pty-b'

function session(split: boolean, pinned: boolean): WorkspaceSessionState {
  const root: TerminalPaneLayoutNode = split
    ? {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF_A },
        second: { type: 'leaf', leafId: LEAF_B }
      }
    : { type: 'leaf', leafId: LEAF_A }
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          ptyId: PTY_A,
          worktreeId: WORKTREE_ID,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          ...(pinned ? { isPinned: true } : {})
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root,
        activeLeafId: LEAF_A,
        expandedLeafId: null,
        ptyIdsByLeafId: split ? { [LEAF_A]: PTY_A, [LEAF_B]: PTY_B } : { [LEAF_A]: PTY_A }
      }
    }
  }
}

export function setupMainOwnedWorkspace(opts: { split?: boolean; pinned?: boolean } = {}) {
  let current = session(opts.split === true, opts.pinned === true)
  const written = new Set<(hostId: string | null) => void>()
  const write = (next: WorkspaceSessionState): void => {
    current = next
    for (const listener of written) {
      listener('local')
    }
  }
  const store = withDurableRuntimeStore(
    withRuntimePaneAdmission({
      getRepos: () => [REPO],
      getRepo: (id: string) => (id === REPO.id ? REPO : undefined),
      getWorkspaceSession: () => current,
      getWorkspaceSessionHostIds: () => ['local'],
      onWorkspaceSessionWritten: (listener: (hostId: string | null) => void) => {
        written.add(listener)
        return () => written.delete(listener)
      },
      setWorkspaceSession: (next: WorkspaceSessionState) => write(next),
      applyLayoutCommand: async (command: LayoutCommand, hostIds: readonly string[] = []) => {
        const change = applyCommandToSession(resolveHostId(hostIds[0]), current, command)
        if (change.session) {
          write(change.session)
        }
        return change.value
      },
      getSettings: () => ({}),
      persistPtyBinding: () => true,
      flushOrThrow: () => undefined
    })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake carries every store method a close, rename and sleep reach.
  const runtime = new OrcaRuntimeService(store as never)
  const stopped: string[] = []
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    stopAndWait: async (ptyId: string) => {
      stopped.push(ptyId)
      return true
    },
    getForegroundProcess: async () => null
  })
  // No window: the headless graph is the one publisher.
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  const ptyIds = opts.split ? [PTY_A, PTY_B] : [PTY_A]
  for (const [index, ptyId] of ptyIds.entries()) {
    const leafId = index === 0 ? LEAF_A : LEAF_B
    runtime.registerPty(ptyId, WORKTREE_ID, null, { tabId: TAB_ID, leafId })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both members are declared on OrcaRuntimeService's inheritance chain.
  const internals = runtime as unknown as {
    issuePtyHandle: (pty: unknown) => string
    ptysById: Map<string, { title?: string | null; titleUpdatedAt?: number }>
  }
  const handleOf = (ptyId: string): string =>
    internals.issuePtyHandle(internals.ptysById.get(ptyId))
  // A paired client's layout stream: each change main makes is one frame.
  let frames = 0
  runtime.subscribeWorkspaceLayouts(() => {
    frames += 1
  })
  return {
    runtime,
    stopped,
    frames: () => frames,
    handleOf,
    ptyRecord: (ptyId: string) => internals.ptysById.get(ptyId),
    session: () => current
  }
}
