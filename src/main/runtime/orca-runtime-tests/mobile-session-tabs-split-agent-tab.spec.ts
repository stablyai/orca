import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import type { WorkspaceSessionState } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-test-fixtures.spec'

// A moved or restored agent tab: its first pane recorded an agent session, its split sibling is a
// plain shell, and no pane has a live terminal. `launchAgent` is tab-wide (D1b-10 real-host run).
function splitAgentTabSession(withRecord: boolean): WorkspaceSessionState {
  const base = makeWorkspaceSessionWithHeadlessTerminal()
  const tab = base.tabsByWorktree[TEST_WORKTREE_ID]?.[0]
  return {
    ...base,
    tabsByWorktree: {
      [TEST_WORKTREE_ID]: tab ? [{ ...tab, ptyId: null, launchAgent: 'codex' }] : []
    },
    terminalLayoutsByTabId: {
      'host-tab': makeHeadlessTerminalLayout({
        [HEADLESS_LEAF_ID]: undefined,
        [HEADLESS_SECOND_LEAF_ID]: undefined
      })
    },
    sleepingAgentSessionsByPaneKey: withRecord
      ? {
          [`host-tab:${HEADLESS_LEAF_ID}`]: {
            paneKey: `host-tab:${HEADLESS_LEAF_ID}`,
            tabId: 'host-tab',
            worktreeId: TEST_WORKTREE_ID,
            agent: 'codex',
            providerSession: { key: 'session_id', id: 'codex-session-1' },
            prompt: 'do the thing',
            state: 'done',
            capturedAt: 1,
            updatedAt: 1,
            origin: 'worktree-sleep'
          }
        }
      : {}
  }
}

function startRuntime(session: WorkspaceSessionState): {
  runtime: OrcaRuntimeService
  spawn: ReturnType<typeof vi.fn>
} {
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
  const spawn = vi.fn().mockResolvedValue({ id: 'started-pty' })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture store implements the runtime store methods these tests reach.
  const runtime = new OrcaRuntimeService(runtimeStore as never)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  return { runtime, spawn }
}

function spawnCommand(spawn: ReturnType<typeof vi.fn>): string {
  const args: unknown = spawn.mock.calls[0]?.[0]
  return typeof args === 'object' && args !== null && 'command' in args
    ? String(args.command ?? '')
    : ''
}

const activate = (runtime: OrcaRuntimeService, leafId: string) =>
  runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', leafId, {
    notifyClients: false,
    navigation: 'caller',
    intent: 'user'
  })

describe('OrcaRuntimeService', () => {
  describe('a split agent tab starting with no live terminal', () => {
    it('starts the split sibling as a plain shell, not as a fresh agent', async () => {
      const { runtime, spawn } = startRuntime(splitAgentTabSession(true))

      await activate(runtime, HEADLESS_SECOND_LEAF_ID)

      expect(spawn).toHaveBeenCalledOnce()
      expect(spawnCommand(spawn)).not.toContain('codex')
      expect(spawn.mock.calls[0]?.[0]).not.toMatchObject({ launchAgent: 'codex' })
    })

    it('still resumes the agent in the pane that recorded it', async () => {
      const { runtime, spawn } = startRuntime(splitAgentTabSession(true))

      await activate(runtime, HEADLESS_LEAF_ID)

      expect(spawnCommand(spawn)).toContain('codex-session-1')
    })

    it('does not start a fresh agent in either pane when no pane recorded one', async () => {
      const { runtime, spawn } = startRuntime(splitAgentTabSession(false))

      await activate(runtime, HEADLESS_LEAF_ID)

      expect(spawnCommand(spawn)).not.toContain('codex')
    })
  })
})
