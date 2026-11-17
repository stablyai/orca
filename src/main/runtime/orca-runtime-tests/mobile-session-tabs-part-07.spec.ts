import type { RuntimeMobileSessionTabsResult } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import '../orca-runtime-test-mocks/setup.spec'
import { getDefaultWorkspaceSession } from '../../../shared/orca-profiles/constants'

import {
  HEADLESS_LEAF_ID,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from './orca-runtime-test-fixtures.spec'
import './orca-runtime-test-scenario-builders.spec'
import '../../agent-launch/agent-launch-pane-attachment'
import '../../../shared/workspace-layout/stable-pane-id'
import '../../../shared/workspace-layout/layout-owner-switch'

describe('OrcaRuntimeService', () => {
  it('publishes a recovered SSH pane when its relay becomes ready after an empty restart replay', async () => {
    const ptyId = 'ssh:ssh-1@@pty-recovered'
    const sshSession = makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'host-tab',
            ptyId,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Recovered SSH Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: ptyId })
      }
    })
    const localSession = getDefaultWorkspaceSession()
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
      getWorkspaceSession: (hostId?: string | null) =>
        hostId === 'ssh:ssh-1' ? sshSession : localSession
    } as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: ptyId, cwd: TEST_WORKTREE_PATH, title: 'Recovered SSH Terminal' }
      ]
    })
    await runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer-empty-restart',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ]
    })
    const events: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => events.push(snapshot))
    const reconcile = vi
      .spyOn(runtime, 'reconcileLegacyWorkerTerminals')
      .mockReturnValue(new Promise(() => undefined))

    runtime.notifySshRelayReady('ssh-1')
    await vi.waitFor(() =>
      expect(
        events.some((snapshot) =>
          snapshot.tabs.some(
            (tab) => tab.type === 'terminal' && tab.ptyId === ptyId && tab.status === 'ready'
          )
        )
      ).toBe(true)
    )

    expect(events.at(-1)?.tabs).toEqual([
      expect.objectContaining({
        parentTabId: 'host-tab',
        ptyId,
        status: 'ready',
        terminal: expect.any(String)
      })
    ])
    expect(reconcile).toHaveBeenCalledWith({
      connectionId: 'ssh-1',
      materializeRenderer: false
    })
  })
})
