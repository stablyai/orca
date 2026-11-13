import '../runtime/orca-runtime-tests/runtime-test-module-registration.spec'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentHookServer as server, _internals } from '../agent-hooks/server/agent-hook-server'
import { agentHookRuntimeDeps } from '../agent-hooks/runtime/agent-hook-runtime-deps'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { AgentStatusObservedPaneIdentities } from '../runtime/terminal/identity/agent-status-observed-pane-identity'
import type { Store } from '../persistence/loading-store/store'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../runtime/orca-runtime-tests/orca-runtime-test-fixtures.spec'
import {
  bindPaneFirst,
  withBoundPane
} from '../runtime/orca-runtime-tests/bind-first-pane.test-fixture'
import { bindTerminalPaneStatusLifecycle } from '../ipc/pty/pane/terminal-pane-status-lifecycle'
import { rememberPaneKeyForPty, paneKeyPtyId, ptyPaneKey } from '../ipc/pty/pane/key-state'
import { ptyIncarnationById, ptyOwnership } from '../ipc/pty/provider/ownership-state'
import { getLocalPtyProvider, setLocalPtyProvider } from '../ipc/pty/provider/registry'
import type { IPtyProvider } from '../providers/pty-provider-contract'
import { stopRendererOwnedPty } from '../ipc/pty/ipc/renderer-kill'
import { toAppSshPtyId } from '../providers/ssh-pty-id'
import { getConnectionExecutionHostId } from '../../shared/execution-host'
import {
  installMainWindowAgentStatusListeners,
  clearMainWindowAgentStatusListeners
} from './main-window/main-window-agent-status'

const frames = vi.hoisted(() => ({ send: vi.fn(), popout: vi.fn() }))
vi.mock('./main-process-state', () => ({
  mainProcessState: { mainWindow: { isDestroyed: () => false, webContents: frames }, runtime: null }
}))
vi.mock('../window/dashboard-popout-window', () => ({
  getDashboardPopoutWindow: () => ({ webContents: { send: frames.popout } })
}))
vi.mock('./main-window/synthetic-title-runtime', () => ({
  stopSyntheticTitleSpinnerTimer: () => {}
}))

const PANE = `host-tab:${HEADLESS_LEAF_ID}`
const INCARNATION = 'initial-incarnation'
let home: string
let runtime: OrcaRuntimeService | undefined
const originalProvider = getLocalPtyProvider()
const ownedPtys = new Set<string>()

beforeEach(async () => {
  _internals.resetCachesForTests()
  home = mkdtempSync(join(tmpdir(), 'orca-sleep-forward-'))
  await server.start({ env: 'production', userDataPath: home })
  frames.send.mockClear()
  frames.popout.mockClear()
  installMainWindowAgentStatusListeners({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this option is unused; delivery uses the mocked main-process window.
    window: {} as BrowserWindow,
    onRecordAgentState: () => {}
  })
})
afterEach(async () => {
  clearMainWindowAgentStatusListeners()
  for (const id of ownedPtys) {
    await runtime?.onPtyExit(id, 0)
    ptyPaneKey.delete(id)
    ptyIncarnationById.delete(id)
    ptyOwnership.delete(id)
  }
  ownedPtys.clear()
  paneKeyPtyId.delete(PANE)
  runtime = undefined
  server.stop()
  bindTerminalPaneStatusLifecycle(undefined, undefined)
  setLocalPtyProvider(originalProvider)
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

function syncPaneGraph(
  runtime: OrcaRuntimeService,
  ptyId: string,
  binding: { tabId: string; leafId: string; incarnationId: string }
): void {
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        ...binding,
        worktreeId: TEST_WORKTREE_ID,
        title: 'Agent',
        activeLeafId: HEADLESS_LEAF_ID,
        layout: null
      }
    ],
    leaves: [{ ...binding, worktreeId: TEST_WORKTREE_ID, ptyId, paneRuntimeId: 1 }]
  })
}

function setup(ptyId: string, connectionId: string | null) {
  const binding = { tabId: 'host-tab', leafId: HEADLESS_LEAF_ID, incarnationId: INCARNATION }
  const session = withBoundPane(makeWorkspaceSessionWithHeadlessTerminal(), {
    ...binding,
    worktreeId: TEST_WORKTREE_ID,
    ptyId
  })
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    session,
    getConnectionExecutionHostId(connectionId)
  )
  runtime = new OrcaRuntimeService(
    runtimeStore,
    undefined,
    agentHookRuntimeDeps(server, new AgentStatusObservedPaneIdentities(), () => ({}))
  )
  runtime.registerPty(ptyId, TEST_WORKTREE_ID, connectionId, binding)
  ownedPtys.add(ptyId)
  runtime.attachWindow(1)
  syncPaneGraph(runtime, ptyId, binding)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the placement adapter reads only the fixture's real getWorkspaceSession implementation.
  bindTerminalPaneStatusLifecycle(runtime, runtimeStore as unknown as Store)
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'host-tab',
    worktreeId: TEST_WORKTREE_ID,
    connectionId,
    payload: { state: 'done', prompt: 'Finished task', agentType: 'unknown' }
  })
  return { runtime, runtimeStore, binding }
}

it('forwards the saved Done marker to both windows before the sleep kill resolves', async () => {
  const id = 'local-sleeping-pty'
  const h = setup(id, null)
  rememberPaneKeyForPty(id, PANE)
  ptyIncarnationById.set(id, INCARNATION)
  ptyOwnership.set(id, 'local')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the injected stop acknowledges shutdown without launching a process or calling other provider methods.
  setLocalPtyProvider({
    shutdown: async () => {},
    listProcesses: async () => []
  } as unknown as IPtyProvider)
  const order: string[] = []
  frames.send.mockImplementation((channel, frame) => {
    if (channel === 'agentStatus:set' && frame.paneSleep) {
      order.push('sleep')
    }
  })
  await stopRendererOwnedPty(
    {
      runtime: h.runtime,
      getLocalPtyProviderStartupPromise: () => undefined,
      shutdownProviderAndDetectExit: async () => false,
      rememberSyntheticKillExit: () => {},
      sendPtyExitToRenderer: () => {}
    },
    { id, keepHistory: true }
  ).then(() => order.push('reply'))
  expect(order[0]).toBe('sleep')
  expect(order.at(-1)).toBe('reply')
  expect(frames.popout).toHaveBeenCalledWith(
    'agentStatus:set',
    expect.objectContaining({
      state: 'done',
      isReplay: true,
      paneSleep: { ptyId: id, incarnationId: INCARNATION }
    })
  )
  expect(server.getStatusSnapshotForPane(PANE)[0]?.paneSleep).toEqual({
    ptyId: id,
    incarnationId: INCARNATION
  })
})

it.each([false, true])(
  'settles a delayed SSH exit only while its runtime binding owns the pane; successor=%s',
  async (successor) => {
    const id = toAppSshPtyId('ssh-1', 'remote-sleep')
    const h = setup(id, 'ssh-1')
    const settle = h.runtime.intentionalPtyStops.mark(id, 'reversible', INCARNATION)
    settle(true)
    expect(paneKeyPtyId.has(PANE)).toBe(false)
    if (successor) {
      const replacement = toAppSshPtyId('ssh-1', 'replacement')
      const replacementBinding = { ...h.binding, incarnationId: 'replacement-incarnation' }
      bindPaneFirst(
        h.runtime,
        {
          ...replacementBinding,
          worktreeId: TEST_WORKTREE_ID,
          ptyId: replacement
        },
        getConnectionExecutionHostId('ssh-1')
      )
      h.runtime.registerPty(replacement, TEST_WORKTREE_ID, 'ssh-1', replacementBinding)
      syncPaneGraph(h.runtime, replacement, replacementBinding)
      ownedPtys.add(replacement)
      expect(h.runtime.resolveTerminalPane(PANE)).toMatchObject({
        ptyId: replacement,
        incarnationId: 'replacement-incarnation'
      })
    }
    await h.runtime.onPtyExit(id, 0, INCARNATION, { hostExitConfirmed: true })
    const row = server.getStatusSnapshotForPane(PANE)[0]
    if (successor) {
      expect(row?.paneSleep).toBeUndefined()
    } else {
      expect(row).toMatchObject({
        state: 'done',
        paneSleep: { ptyId: id, incarnationId: INCARNATION }
      })
    }
  }
)
