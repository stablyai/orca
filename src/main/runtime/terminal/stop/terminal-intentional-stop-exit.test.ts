import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { Store } from '../../../persistence/loading-store/store'
import { ProfileStateSqliteAuthority } from '../../../persistence/profile-state/profile-state-sqlite-authority'
import { wirePtyIpcSession } from '../../../ipc/pty/delivery/wire-session'
import '../../../ipc/pty/delivery/visibility-state'
import { bindProviderListeners } from '../../../ipc/pty/provider/bind-listeners'
import {
  stopRendererOwnedPty,
  stopReplacedPanePty,
  type PtyKillIpcDeps
} from '../../../ipc/pty/ipc/renderer-kill'
import { ptyIncarnationById, ptyOwnership } from '../../../ipc/pty/provider/ownership-state'
import { getLocalPtyProvider, setLocalPtyProvider } from '../../../ipc/pty/provider/registry'
import { createPtyIpcSession } from '../../../ipc/pty/session'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import { OrcaRuntimeService } from '../../orca-runtime'

import {
  INCARNATION_ID,
  LEAF_ID,
  PTY_ID,
  REPO_ID,
  TAB_ID,
  WORKTREE_ID,
  WORKTREE_PATH,
  makeSession
} from '../../__fixtures__/orca-runtime-terminal-close-continuity-state-fixture'
import { advanceTerminalTopologyRevision } from '../../../persistence/terminal-topology/pane-ownership/terminal-topology-membership'

const REPLACEMENT_PTY_ID = 'pty-close-continuity-replacement'
const REPLACEMENT_INCARNATION_ID = '77777777-7777-4777-8777-777777777777'

const directories: string[] = []
const stores: Store[] = []
const priorProvider = getLocalPtyProvider()
afterEach(() => {
  vi.useRealTimers()
  setLocalPtyProvider(priorProvider)
  ptyOwnership.delete(PTY_ID)
  ptyIncarnationById.delete(PTY_ID)
  for (const store of stores.splice(0)) {
    store.freezeWrites()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** Use real store/runtime with renderer stub; lateProviderExit lets the kill reply overtake the provider exit and force a synthetic one. */
function createHarness(opts: { lateProviderExit?: boolean; folder?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-intentional-stop-'))
  directories.push(directory)
  const store = new Store({
    dataFile: join(directory, 'orca-data.json'),
    profileStateAuthority: new ProfileStateSqliteAuthority(
      join(directory, 'profile-state.db'),
      'intentional-stop'
    )
  })
  stores.push(store)
  store.addRepo({
    id: REPO_ID,
    path: WORKTREE_PATH,
    displayName: 'Fixture',
    badgeColor: 'gray',
    addedAt: 1,
    // Why: a folder workspace resolves without git, which the sleep transaction needs.
    ...(opts.folder ? { kind: 'folder' as const } : {})
  })
  store.setWorkspaceSession(advanceTerminalTopologyRevision(makeSession(), WORKTREE_ID))
  store.flushOrThrow()
  const runtime = new OrcaRuntimeService(store)
  runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId: INCARNATION_ID
  })
  ptyOwnership.set(PTY_ID, 'local')
  ptyIncarnationById.set(PTY_ID, INCARNATION_ID)
  let emitProviderExit: Parameters<IPtyProvider['onExit']>[0] | undefined
  const provider = {
    onData: () => () => {},
    onExit: (listener: typeof emitProviderExit) => {
      emitProviderExit = listener
      return () => {}
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listeners bind only onData and onExit, and the renderer kill hands the provider to the shutdown port below.
  setLocalPtyProvider(provider as unknown as IPtyProvider)
  const rendererSend = vi.fn()
  const window = { isDestroyed: () => false, webContents: { send: rendererSend } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exit delivery reads only isDestroyed and webContents.send.
  const session = createPtyIpcSession({ mainWindow: window as unknown as BrowserWindow, runtime })
  wirePtyIpcSession(session)
  bindProviderListeners(session)
  const deps: PtyKillIpcDeps = {
    store,
    runtime,
    getLocalPtyProviderStartupPromise: () => undefined,
    // The provider's own exit, delivered the way its listener delivers it.
    shutdownProviderAndDetectExit: async (_provider, id) => {
      if (opts.lateProviderExit) {
        return false
      }
      runtime.onPtyExit(id, 0, INCARNATION_ID, { providerExitObserved: true })
      session.sendPtyExitToRenderer({ id, code: 0, incarnationId: INCARNATION_ID })
      return true
    },
    rememberSyntheticKillExit: session.rememberSyntheticKillExit,
    sendPtyExitToRenderer: session.sendPtyExitToRenderer
  }
  return {
    store,
    runtime,
    deps,
    emitProviderExit: (incarnationId: string) =>
      emitProviderExit?.({ id: PTY_ID, code: 0, incarnationId }),
    /** The exit main synthesizes for each session when it restarts the daemon. */
    emitDaemonRestartExit: (replacedByRestart?: true) =>
      emitProviderExit?.({
        id: PTY_ID,
        code: -1,
        incarnationId: INCARNATION_ID,
        ...(replacedByRestart ? { replacedByRestart } : {})
      }),
    boundPtyId: () =>
      store.getWorkspaceSession().terminalLayoutsByTabId[TAB_ID]?.ptyIdsByLeafId?.[LEAF_ID] ?? null,
    tabIds: () => (store.getWorkspaceSession().tabsByWorktree[WORKTREE_ID] ?? []).map((t) => t.id),
    rendererExits: () =>
      rendererSend.mock.calls.filter(([channel]) => channel === 'pty:exit').map(([, p]) => p)
  }
}

describe('intentional stops keep the pane through the exit', () => {
  it('retires the pane when an ordinary close ends the process', async () => {
    const harness = createHarness()

    await stopRendererOwnedPty(harness.deps, { id: PTY_ID })

    expect(harness.boundPtyId()).toBeNull()
    expect(harness.rendererExits()).toEqual([
      { id: PTY_ID, code: 0, incarnationId: INCARNATION_ID, hostId: 'local' }
    ])
  })

  it('keeps a typed pane that a restart replaces, and binds the replacement', async () => {
    const harness = createHarness()
    harness.runtime.terminalRunFacts.recordSpawnCommit({
      id: PTY_ID,
      incarnationId: INCARNATION_ID
    })
    harness.runtime.terminalRunFacts.recordInput(PTY_ID, 'driving', 'ls\r')

    await stopReplacedPanePty(harness.deps, PTY_ID)
    expect(harness.boundPtyId()).toBe(PTY_ID)
    await harness.store.persistPtyBinding({
      worktreeId: WORKTREE_ID,
      tabId: TAB_ID,
      leafId: LEAF_ID,
      ptyId: REPLACEMENT_PTY_ID,
      incarnationId: REPLACEMENT_INCARNATION_ID,
      origin: 'spawn'
    })

    expect(harness.tabIds()).toEqual([TAB_ID])
    expect(harness.boundPtyId()).toBe(REPLACEMENT_PTY_ID)
    expect(
      harness.store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey?.[
        makePaneKey(TAB_ID, LEAF_ID)
      ]
    ).toBe(REPLACEMENT_INCARNATION_ID)
    expect(harness.rendererExits()).toEqual([
      {
        id: PTY_ID,
        code: 0,
        incarnationId: INCARNATION_ID,
        hostId: 'local',
        replacedByRestart: true
      }
    ])
  })

  it('keeps the pane through the synthetic exit and the provider exit that follows it', async () => {
    const harness = createHarness({ lateProviderExit: true })

    await stopRendererOwnedPty(harness.deps, { id: PTY_ID, keepHistory: true })
    harness.emitProviderExit(INCARNATION_ID)

    expect(harness.tabIds()).toEqual([TAB_ID])
    expect(harness.boundPtyId()).toBe(PTY_ID)
    expect(harness.rendererExits()).toEqual([
      {
        id: PTY_ID,
        code: -1,
        incarnationId: INCARNATION_ID,
        hostId: 'local',
        preserveRendererBinding: true
      }
    ])
  })

  it('keeps the tab and its wake binding when the runtime puts the worktree to sleep', async () => {
    const harness = createHarness({ folder: true })
    const inventories = [[{ id: PTY_ID, worktreeId: WORKTREE_ID, cwd: WORKTREE_PATH, title: 'a' }]]
    harness.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait: async (ptyId) => {
        harness.runtime.onPtyExit(ptyId, -1, INCARNATION_ID, { providerExitObserved: true })
        return true
      },
      getForegroundProcess: async () => null,
      listProcesses: async () => inventories.shift() ?? []
    })

    await harness.runtime.sleepTerminalsForWorktree(`id:${WORKTREE_ID}`)

    expect(harness.tabIds()).toEqual([TAB_ID])
    expect(harness.boundPtyId()).toBe(PTY_ID)
  })
})
