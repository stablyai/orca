import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { Store } from '../persistence/loading-store/store'
import { wirePtyIpcSession } from '../ipc/pty/delivery/wire-session'
import { SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS } from '../ipc/pty/delivery/visibility-state'
import { bindProviderListeners } from '../ipc/pty/provider/bind-listeners'
import {
  stopRendererOwnedPty,
  stopReplacedPanePty,
  type PtyKillIpcDeps
} from '../ipc/pty/ipc/renderer-kill'
import { ptyIncarnationById, ptyOwnership } from '../ipc/pty/provider/ownership-state'
import { getLocalPtyProvider, setLocalPtyProvider } from '../ipc/pty/provider/registry'
import { createPtyIpcSession } from '../ipc/pty/session'
import type { IPtyProvider } from '../providers/types'
import { OrcaRuntimeService } from './orca-runtime'
import {
  INCARNATION_ID,
  LEAF_ID,
  PTY_ID,
  REPO_ID,
  TAB_ID,
  WORKTREE_ID,
  WORKTREE_PATH,
  makeSession
} from './__fixtures__/orca-runtime-terminal-close-continuity-state-fixture'
import { advanceTerminalTopologyRevision } from './workspace-session-terminal-membership-authority'

const REPLACEMENT_PTY_ID = 'pty-close-continuity-replacement'
const REPLACEMENT_INCARNATION_ID = '77777777-7777-4777-8777-777777777777'
const LATER_INCARNATION_ID = '88888888-8888-4888-8888-888888888888'

const directories: string[] = []
const priorProvider = getLocalPtyProvider()
afterEach(() => {
  vi.useRealTimers()
  setLocalPtyProvider(priorProvider)
  ptyOwnership.delete(PTY_ID)
  ptyIncarnationById.delete(PTY_ID)
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** A real store and runtime with one bound pane, and main's exit delivery to a renderer stub.
 *  `lateProviderExit`: the kill's reply overtakes the exit, so main synthesizes one and the
 *  provider's own exit arrives later through its listener. */
function createHarness(opts: { lateProviderExit?: boolean; folder?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-intentional-stop-'))
  directories.push(directory)
  const store = new Store({ dataFile: join(directory, 'orca-data.json') })
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
  ptyOwnership.set(PTY_ID, null)
  ptyIncarnationById.set(PTY_ID, INCARNATION_ID)
  let emitProviderExit:
    | ((payload: { id: string; code: number; incarnationId?: string }) => void)
    | undefined
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
      { id: PTY_ID, code: 0, incarnationId: INCARNATION_ID }
    ])
  })

  it('keeps the tab and its wake binding when the renderer hibernates the pane', async () => {
    const harness = createHarness()

    await stopRendererOwnedPty(harness.deps, { id: PTY_ID, keepHistory: true })

    expect(harness.tabIds()).toEqual([TAB_ID])
    expect(harness.boundPtyId()).toBe(PTY_ID)
    expect(harness.rendererExits()).toEqual([
      { id: PTY_ID, code: 0, incarnationId: INCARNATION_ID, preserveRendererBinding: true }
    ])
  })

  it('keeps a typed pane that a restart replaces, and binds the replacement', async () => {
    const harness = createHarness()
    harness.runtime.terminalRunFacts.recordSpawnCommit({
      id: PTY_ID,
      incarnationId: INCARNATION_ID
    })
    harness.runtime.terminalRunFacts.recordUserInput(PTY_ID)

    await stopReplacedPanePty(harness.deps, PTY_ID)
    expect(harness.boundPtyId()).toBe(PTY_ID)
    harness.store.persistPtyBinding({
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
      { id: PTY_ID, code: 0, incarnationId: INCARNATION_ID, replacedByRestart: true }
    ])
  })

  it('keeps the pane through the synthetic exit and the provider exit that follows it', async () => {
    const harness = createHarness({ lateProviderExit: true })

    await stopRendererOwnedPty(harness.deps, { id: PTY_ID, keepHistory: true })
    harness.emitProviderExit(INCARNATION_ID)

    expect(harness.tabIds()).toEqual([TAB_ID])
    expect(harness.boundPtyId()).toBe(PTY_ID)
    expect(harness.rendererExits()).toEqual([
      { id: PTY_ID, code: -1, incarnationId: INCARNATION_ID, preserveRendererBinding: true }
    ])
  })

  it('never reads the exit of a later process on the same id as the stop', async () => {
    const harness = createHarness({ lateProviderExit: true })
    await stopRendererOwnedPty(harness.deps, { id: PTY_ID, keepHistory: true })
    harness.runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: LATER_INCARNATION_ID
    })
    ptyIncarnationById.set(PTY_ID, LATER_INCARNATION_ID)
    harness.store.persistPtyBinding({
      worktreeId: WORKTREE_ID,
      tabId: TAB_ID,
      leafId: LEAF_ID,
      ptyId: PTY_ID,
      incarnationId: LATER_INCARNATION_ID,
      origin: 'reattach'
    })

    harness.emitProviderExit(LATER_INCARNATION_ID)

    expect(harness.boundPtyId()).toBeNull()
    expect(harness.rendererExits().at(-1)).toEqual({
      id: PTY_ID,
      code: 0,
      incarnationId: LATER_INCARNATION_ID
    })
  })

  it('forgets the stop once the duplicate-exit window after it closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const harness = createHarness({ lateProviderExit: true })
    await stopRendererOwnedPty(harness.deps, { id: PTY_ID, keepHistory: true })

    vi.advanceTimersByTime(SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS - 1)
    expect(harness.runtime.intentionalPtyStops.claimExit(PTY_ID, INCARNATION_ID)).toBe('reversible')
    vi.advanceTimersByTime(1)

    expect(harness.runtime.intentionalPtyStops.claimExit(PTY_ID, INCARNATION_ID)).toBeNull()
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
