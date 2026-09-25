import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { Store } from '../persistence/loading-store/store'
import { wirePtyIpcSession } from '../ipc/pty/delivery/wire-session'
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

const directories: string[] = []
const priorProvider = getLocalPtyProvider()
afterEach(() => {
  setLocalPtyProvider(priorProvider)
  ptyOwnership.delete(PTY_ID)
  ptyIncarnationById.delete(PTY_ID)
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** A real store and runtime with one bound pane, and main's exit delivery to a renderer stub. */
function createHarness() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-intentional-stop-'))
  directories.push(directory)
  const store = new Store({ dataFile: join(directory, 'orca-data.json') })
  store.addRepo({
    id: REPO_ID,
    path: WORKTREE_PATH,
    displayName: 'Fixture',
    badgeColor: 'gray',
    addedAt: 1
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the renderer kill reads only the provider the registry returns and hands it to the shutdown port below.
  setLocalPtyProvider({} as IPtyProvider)
  const rendererSend = vi.fn()
  const window = { isDestroyed: () => false, webContents: { send: rendererSend } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exit delivery reads only isDestroyed and webContents.send.
  const session = createPtyIpcSession({ mainWindow: window as unknown as BrowserWindow, runtime })
  wirePtyIpcSession(session)
  const deps: PtyKillIpcDeps = {
    store,
    runtime,
    getLocalPtyProviderStartupPromise: () => undefined,
    // The provider's own exit, delivered the way its listener delivers it.
    shutdownProviderAndDetectExit: async (_provider, id) => {
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
})
