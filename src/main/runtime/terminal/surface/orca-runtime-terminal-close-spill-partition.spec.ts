import '../../orca-runtime-tests/runtime-durable-store-fixture'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import '../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import '../../../../shared/workspace-layout/terminal-surfaces/closed-terminal-tab-tombstones'

import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import './mobile-session-terminal-projection'
import '../../orca-runtime'
import { terminalSurfaceCloseMutation } from './terminal-surface-close'
import { capturePersistedTerminalTabCopy } from './workspace-session-terminal-tab-retirement-identity'

export function registerOrcaRuntimeTerminalCloseSpillPartitionTests(): void {
  const WORKTREE_ID = 'repo::/worktree'
  const LEAF = '11111111-1111-4111-8111-111111111111'
  const SPILL_HOST_ID: ExecutionHostId = 'runtime:env-1'

  function terminalTab(id: string, ptyId: string) {
    return {
      id,
      ptyId,
      worktreeId: WORKTREE_ID,
      title: id,
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
  }

  function sessionWithTab(id: string, ptyId: string): WorkspaceSessionState {
    return {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [WORKTREE_ID]: [terminalTab(id, ptyId)] },
      terminalLayoutsByTabId: {
        [id]: {
          root: { type: 'leaf', leafId: LEAF },
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF]: ptyId }
        }
      },
      terminalPtyIncarnationsByPaneKey: { [`${id}:${LEAF}`]: `${id}-incarnation` }
    }
  }

  describe('terminal close across local and runtime session partitions (#18202)', () => {
    it('refuses when a second copy was rebound after the close was asked', () => {
      const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
        [SPILL_HOST_ID, sessionWithTab('target', 'target-pty')],
        ['runtime:env-0', sessionWithTab('target', 'target-pty')]
      ])
      const requestedHolders = new Map(
        [...sessions].map(([hostId, session]) => [
          hostId,
          capturePersistedTerminalTabCopy(session, WORKTREE_ID, 'target')
        ])
      )
      const second = sessions.get('runtime:env-0')!
      second.terminalLayoutsByTabId.target!.ptyIdsByLeafId = { [LEAF]: 'replacement-pty' }
      second.terminalPtyIncarnationsByPaneKey = { [`target:${LEAF}`]: 'replacement-incarnation' }
      const setSession = vi.fn()
      const onClosed = vi.fn()

      const mutation = terminalSurfaceCloseMutation({
        worktreeId: WORKTREE_ID,
        target: { kind: 'tab', tabId: 'target' },
        options: {},
        requestedSession: sessions.get(SPILL_HOST_ID),
        requestedHolders,
        ownerMatches: () => true,
        hostIds: () => [...sessions.keys()],
        getSession: (hostId) => sessions.get(hostId),
        setSession,
        onClosed
      })()

      expect(mutation).toEqual({
        value: new Error('terminal_pane_owner_changed'),
        persist: false
      })
      expect(setSession).not.toHaveBeenCalled()
      expect(onClosed).not.toHaveBeenCalled()
    })
  })
}
