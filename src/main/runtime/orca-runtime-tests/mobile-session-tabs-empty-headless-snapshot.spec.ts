import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-test-fixtures.spec'
import { getRuntimeBrowserPageRegistry } from '../runtime-browser-page-registry'

// #25900: a windowless host listed no tabs for a worktree whose saved session still had live
// agent terminals, so a client waiting to reattach heard "nothing here" and stayed on Reconnecting.

const AGENT_PTY_ID = 'daemon-agent-pty'
const PLACEMENT = {
  kind: 'client' as const,
  browserHostClientId: 'host-a',
  browserHostGeneration: 3,
  pageHostGeneration: 9
}

function makeHost() {
  const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      activeTabIdByWorktree: {},
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      terminalLayoutsByTabId: {}
    })
  )
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'unexpected-pty' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  const pages = getRuntimeBrowserPageRegistry(runtime)
  return {
    runtime,
    openPage: (browserPageId: string) =>
      pages.publishClientPage({
        browserPageId,
        workspaceId: TEST_WORKTREE_ID,
        browserProfileId: 'default',
        executionHostKey: 'native:runtime-a:7',
        placement: PLACEMENT,
        url: 'https://client.test/',
        title: 'Client page',
        loading: false,
        active: true
      }),
    closePage: (browserPageId: string) => pages.retirePage(browserPageId, PLACEMENT),
    saveAgentTerminal: () => {
      const session = getSession()
      setSession({
        ...session,
        activeTabIdByWorktree: { [TEST_WORKTREE_ID]: 'agent-tab' },
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: 'agent-tab',
              ptyId: AGENT_PTY_ID,
              worktreeId: TEST_WORKTREE_ID,
              title: 'codex',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          'agent-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: AGENT_PTY_ID })
        }
      })
    }
  }
}

async function listedTabTypes(runtime: OrcaRuntimeService): Promise<string[]> {
  const snapshots = await runtime.listAllMobileSessionTabs()
  return (snapshots.find((snapshot) => snapshot.worktree === TEST_WORKTREE_ID)?.tabs ?? [])
    .map((tab) => tab.type)
    .sort()
}

describe('OrcaRuntimeService empty headless session snapshot', () => {
  it('rebuilds the terminals when the last browser closes instead of listing nothing', async () => {
    const host = makeHost()
    host.openPage('page-1')
    expect(await listedTabTypes(host.runtime)).toEqual(['browser'])

    host.saveAgentTerminal()
    host.closePage('page-1')

    expect(await listedTabTypes(host.runtime)).toEqual(['terminal'])
  })

  it('keeps the saved terminals listed when a browser opens over an emptied snapshot', async () => {
    const host = makeHost()
    host.openPage('page-1')
    await listedTabTypes(host.runtime)
    host.closePage('page-1')
    // The emptied snapshot this host built stays stored while the session gains its terminal.
    expect(await listedTabTypes(host.runtime)).toEqual([])

    host.saveAgentTerminal()
    host.openPage('page-2')

    expect(await listedTabTypes(host.runtime)).toEqual(['browser', 'terminal'])
    const listed = await host.runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(listed.tabs.map((tab) => tab.type).sort()).toEqual(['browser', 'terminal'])
  })
})
