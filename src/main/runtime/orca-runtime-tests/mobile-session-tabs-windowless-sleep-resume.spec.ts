import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { electronMocks } from '../orca-runtime-test-mocks/setup.spec'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  HEADLESS_LEAF_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import type { RuntimeStore } from '../construction/runtime-store-contract'

const PANE_KEY = `host-tab:${HEADLESS_LEAF_ID}`
// Pane-owned captures must not be resumed twice (#11598).
const PANE_OWNED = { origin: 'worktree-sleep', state: 'done', restoreOnTabOpenOnly: true }

function makeWorkingSleepStore(overrides: Partial<SleepingAgentSessionRecord> = {}) {
  const record: SleepingAgentSessionRecord = {
    paneKey: PANE_KEY,
    tabId: 'host-tab',
    worktreeId: TEST_WORKTREE_ID,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'provider-session-1' },
    prompt: 'do the thing',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'worktree-sleep',
    ...overrides
  }
  const fixture = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record }
    })
  )
  const baseSettings = fixture.runtimeStore.getSettings
  // Resume must preserve permissions rather than inherit wider launch defaults.
  fixture.runtimeStore.getSettings = () => ({
    ...baseSettings(),
    agentDefaultArgs: { claude: '--dangerously-skip-permissions' }
  })
  return fixture
}

function withClaudeLaunchedTab(fixture: ReturnType<typeof makeWorkingSleepStore>): void {
  const session = structuredClone(fixture.getSession())
  const tab = session.tabsByWorktree[TEST_WORKTREE_ID]?.[0]
  if (tab) {
    tab.launchAgent = 'claude'
  }
  fixture.setSession(session)
}

async function openPane(
  runtimeStore: RuntimeStore,
  windowStatus: 'blocked' | 'openable',
  opts: { spawn?: () => Promise<{ id: string }>; withWindow?: boolean; tap?: boolean } = {}
) {
  const spawn = vi.fn(opts.spawn ?? (() => Promise.resolve({ id: 'persisted-pty' })))
  const runtime = new OrcaRuntimeService(runtimeStore, undefined, {
    getDesktopWindowStatus: () => windowStatus
  })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  await runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  electronMocks.BrowserWindow.fromId.mockReturnValue(null)
  const opened = (async () => {
    if (opts.withWindow) {
      runtime.attachWindow(TEST_WINDOW_ID)
      runtime.markGraphReady(TEST_WINDOW_ID)
      electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false })
      await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, {
        notifyClients: false,
        clientKind: 'runtime'
      })
    }
    if (opts.tap === false) {
      return null
    }
    return runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'host-tab',
      HEADLESS_LEAF_ID,
      {
        notifyClients: false,
        navigation: 'caller',
        intent: 'user'
      }
    )
  })()
  return { opened, spawn, runtime }
}

function spawnedCommand(spawn: ReturnType<typeof vi.fn>, call = 0): string {
  const args: unknown = spawn.mock.calls[call]?.[0]
  return typeof args === 'object' && args !== null && 'command' in args
    ? String(args.command ?? '')
    : ''
}

describe('opening a workspace-slept running agent on a host with no window', () => {
  // A restart that loses the PTY still needs the saved resume flags.
  it('still resumes with the recorded flags after a host restart loses the PTY', async () => {
    const fixture = makeWorkingSleepStore({
      launchConfig: { agentArgs: '--permission-mode plan', agentEnv: {} }
    })
    withClaudeLaunchedTab(fixture)
    await (
      await openPane(fixture.runtimeStore, 'openable')
    ).opened

    const restarted = await openPane(fixture.runtimeStore, 'openable')
    await restarted.opened
    const command = spawnedCommand(restarted.spawn)
    expect(command).toContain('provider-session-1')
    expect(command).toMatch(/--permission-mode'? '?plan/)
    expect(command).not.toContain('--dangerously-skip-permissions')
  })

  it('resumes from both of two overlapping opens of the pane, never a plain shell', async () => {
    const fixture = makeWorkingSleepStore()
    withClaudeLaunchedTab(fixture)
    const { opened, spawn, runtime } = await openPane(fixture.runtimeStore, 'openable')
    const second = runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'host-tab',
      HEADLESS_LEAF_ID,
      { notifyClients: false, navigation: 'caller', intent: 'user' }
    )

    await Promise.allSettled([opened, second])
    expect(spawn).toHaveBeenCalled()
    for (let call = 0; call < spawn.mock.calls.length; call += 1) {
      expect(spawnedCommand(spawn, call)).toContain('provider-session-1')
    }
  })

  it('keeps the record for the next open when the pane resume fails to spawn', async () => {
    const fixture = makeWorkingSleepStore()
    const { opened, spawn } = await openPane(fixture.runtimeStore, 'openable', {
      spawn: () => Promise.reject(new Error('spawn failed'))
    })

    await expect(opened).rejects.toThrow('spawn failed')
    expect(spawnedCommand(spawn)).toContain('provider-session-1')
    expect(fixture.getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toMatchObject(
      PANE_OWNED
    )
    const retried = await openPane(fixture.runtimeStore, 'openable')
    await retried.opened
    expect(spawnedCommand(retried.spawn)).toContain('provider-session-1')
  })
})
