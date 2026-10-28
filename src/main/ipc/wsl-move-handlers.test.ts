import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../shared/wsl-host-internal-gate'
import { configureWslHostsGate, resetWslHostsGateForTests } from '../wsl/wsl-host-gate'
import { wslMoveCutoverFixture as cutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { listWslMoveCutovers } from '../persistence/moving-wsl-projects/wsl-move-cutover-journal'
import {
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import {
  isWslMoveWindowWriteHeld,
  setWslMoveReloadableWindow
} from '../persistence/moving-wsl-projects/wsl-move-window-write-hold'
import {
  registerWslMoveDesktopRewriteStore,
  resetWslMoveDesktopRewriteStoresForTests
} from '../persistence/moving-wsl-projects/wsl-move-desktop-rewrite-stores'

type Handler = (event: unknown, request?: unknown) => unknown

const handlers = vi.hoisted(() => new Map<string, Handler>())
vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
  }
}))

import { registerWslMoveHandlers } from './wsl-move-handlers'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-ipc-'))
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  registerWslMoveDesktopRewriteStore({ id: 'renderer-a', side: 'renderer' })
  seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
  flushStorageData.mockReset()
  registerWslMoveHandlers(
    () => userDataPath,
    (senderId) => senderId === MAIN_WINDOW_ID
  )
  loadWslMoveFence(userDataPath)
})
afterEach(() => {
  vi.unstubAllEnvs()
  resetWslMoveDesktopRewriteStoresForTests()
  resetWslMoveFenceForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

const MAIN_WINDOW_ID = 7
const flushStorageData = vi.fn()
const sender = (id: number) => ({ id, session: { flushStorageData } })
const invoke = (channel: string, request?: unknown, senderId = MAIN_WINDOW_ID) =>
  handlers.get(channel)?.({ sender: sender(senderId) }, request)

describe('WSL move IPC', () => {
  it('lists pending renderer rewrites and records one', () => {
    expect(invoke('wslMove:listPendingRendererRewrites')).toMatchObject([
      { migrationId: 'move-1', storeIds: ['renderer-a'] }
    ])
    expect(
      invoke('wslMove:recordStoreRewritten', { migrationId: 'move-1', storeId: 'renderer-a' })
    ).toEqual({ recorded: true })
    // Its only registered store is now recorded, so the move finishes its rewrite.
    expect(listWslMoveCutovers(userDataPath)[0]).toMatchObject({
      phase: 'client-rewritten',
      rewrittenStores: ['renderer-a']
    })
  })

  it.each([
    undefined,
    null,
    'renderer-a',
    { migrationId: 'move-1' },
    { migrationId: 1, storeId: 2 }
  ])('refuses a malformed request %j', (request) => {
    expect(invoke('wslMove:recordStoreRewritten', request)).toEqual({
      recorded: false,
      reason: 'unknown-store'
    })
    expect(listWslMoveCutovers(userDataPath)[0]?.rewrittenStores).toEqual([])
  })

  it('answers empty and refuses with the gate closed', () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    expect(invoke('wslMove:listPendingRendererRewrites')).toEqual([])
    expect(
      invoke('wslMove:recordStoreRewritten', { migrationId: 'move-1', storeId: 'renderer-a' })
    ).toEqual({ recorded: false, reason: 'gated-off' })
    expect(listWslMoveCutovers(userDataPath)[0]?.rewrittenStores).toEqual([])
  })

  it('keeps listing unfinished moves and pending rewrites in serve-only, and nothing when closed', () => {
    rmSync(userDataPath, { recursive: true, force: true })
    userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-ipc-'))
    seedWslMoveCutover(
      userDataPath,
      cutover('move-2', 'destination-committed', { automationsToReenable: ['automation-1'] })
    )
    const open = invoke('wslMove:listUnfinished')
    expect(open).toEqual([expect.objectContaining({ migrationId: 'move-2' })])
    const pending = invoke('wslMove:listPendingRendererRewrites')
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    expect(invoke('wslMove:listUnfinished')).toEqual([])

    configureWslHostsGate({ hasSavedWslHost: () => false, hasWslMoveCutover: () => true })
    try {
      expect(invoke('wslMove:listUnfinished')).toEqual(open)
      expect(invoke('wslMove:listPendingRendererRewrites')).toEqual(pending)
    } finally {
      resetWslHostsGateForTests()
    }
  })

  it('writes the window storage to disk before the ledger entry', () => {
    flushStorageData.mockImplementation(() => {
      expect(listWslMoveCutovers(userDataPath)[0]?.rewrittenStores).toEqual([])
    })
    invoke('wslMove:recordStoreRewritten', { migrationId: 'move-1', storeId: 'renderer-a' })
    expect(flushStorageData).toHaveBeenCalledOnce()
    expect(listWslMoveCutovers(userDataPath)[0]?.rewrittenStores).toEqual(['renderer-a'])
  })

  it('records only for the main window, whose storage holds the renderer stores', () => {
    expect(
      invoke('wslMove:recordStoreRewritten', { migrationId: 'move-1', storeId: 'renderer-a' }, 8)
    ).toEqual({ recorded: false, reason: 'not-main-window' })
    expect(flushStorageData).not.toHaveBeenCalled()
    expect(listWslMoveCutovers(userDataPath)[0]?.rewrittenStores).toEqual([])
  })

  it('brings a moved project back, validating the renderer input', async () => {
    for (const bad of [undefined, null, { kind: 'repo' }, { kind: 'x', id: 'repo-1' }]) {
      expect(await invoke('wslMove:useProjectHereAgain', bad)).toEqual({
        released: false,
        reason: 'not-moved'
      })
    }
    expect(listWslMoveCutovers(userDataPath)).toHaveLength(1)

    const page = { loaded: () => {} }
    const mainWindow = {
      id: MAIN_WINDOW_ID,
      isDestroyed: () => false,
      reload: vi.fn(),
      allowUnload: () => () => {},
      onLoadedOrGone: (listener: () => void) => {
        page.loaded = listener
        return () => {}
      }
    }
    setWslMoveReloadableWindow(() => mainWindow)
    const result = await handlers.get('wslMove:useProjectHereAgain')?.(
      { sender: mainWindow },
      { kind: 'repo', id: 'repo-1' }
    )
    expect(result).toMatchObject({ released: true })
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
    // The page held only chats: its saves are dropped until the reloaded page has loaded.
    expect(isWslMoveWindowWriteHeld()).toBe(true)
    await new Promise((resolve) => setImmediate(resolve))
    expect(mainWindow.reload).toHaveBeenCalledOnce()
    page.loaded()
    expect(isWslMoveWindowWriteHeld()).toBe(false)
    setWslMoveReloadableWindow(() => null)
  })

  // "p5 moved after this project" refused the undo after killing p1's terminals.
  it('refuses a superseded undo before it stops anything on the host', async () => {
    const rewritten = { rewrittenStores: ['renderer-a'] }
    invoke('wslMove:recordStoreRewritten', { migrationId: 'move-1', storeId: 'renderer-a' })
    seedWslMoveCutover(userDataPath, { ...cutover('move-1', 'retained'), ...rewritten })
    seedWslMoveCutover(userDataPath, {
      ...cutover(
        'move-2',
        'retained',
        { supersedesMigrationId: 'move-1' },
        { repoIds: ['repo-5'] }
      ),
      ...rewritten
    })
    loadWslMoveFence(userDataPath)
    const stopHostCopies = vi.fn(async () => 'stopped' as const)
    registerWslMoveHandlers(
      () => userDataPath,
      (senderId) => senderId === MAIN_WINDOW_ID,
      undefined,
      () => ({ stopHostCopies })
    )
    expect(await invoke('wslMove:useProjectHereAgain', { kind: 'repo', id: 'repo-1' })).toEqual({
      released: false,
      reason: 'superseded',
      newerMove: { repoIds: ['repo-5'], folderWorkspaceIds: [] }
    })
    expect(stopHostCopies).not.toHaveBeenCalled()
    expect(listWslMoveCutovers(userDataPath)).toHaveLength(2)
  })

  // P6's unsaved README blocked bringing p9 back.
  it("refuses only for unsaved files in the move's own workspaces, before stopping the host", async () => {
    const stopHostCopies = vi.fn(async () => 'stopped' as const)
    registerWslMoveHandlers(
      () => userDataPath,
      (senderId) => senderId === MAIN_WINDOW_ID,
      undefined,
      () => ({ stopHostCopies })
    )
    const request = (unsavedWorkspaceIds: unknown) => ({
      kind: 'repo',
      id: 'repo-1',
      unsavedWorkspaceIds
    })
    expect(
      await invoke('wslMove:useProjectHereAgain', request(['repo-2::/w', 'repo-1::/w', 7]))
    ).toEqual({ released: false, reason: 'unsaved-files', unsavedWorkspaceIds: ['repo-1::/w'] })
    expect(stopHostCopies).not.toHaveBeenCalled()
    expect(listWslMoveCutovers(userDataPath)).toHaveLength(1)

    setWslMoveReloadableWindow(() => null)
    expect(await invoke('wslMove:useProjectHereAgain', request(['repo-2::/w']))).toMatchObject({
      released: true
    })
    expect(stopHostCopies).toHaveBeenCalledOnce()
  })

  it('brings a project back only for the main window, and only with the gate open', async () => {
    expect(await invoke('wslMove:useProjectHereAgain', { kind: 'repo', id: 'repo-1' }, 8)).toEqual({
      released: false,
      reason: 'failed',
      detail: 'not-main-window'
    })
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    // Gate first: even malformed input from a non-main window gets the gated answer.
    expect(await handlers.get('wslMove:useProjectHereAgain')?.({}, null)).toEqual({
      released: false,
      reason: 'gated-off'
    })
    expect(listWslMoveCutovers(userDataPath)).toHaveLength(1)
  })

  // The host's copy of the agent kept running beside the one resumed here.
  it.each([
    ['unreachable', 'host-unreachable'],
    ['still-running', 'host-still-running']
  ] as const)(
    'keeps the move when the host copies are %s, so no agent resumes here beside them',
    async (stop, reason) => {
      const stopHostCopies = vi.fn(async () => stop)
      registerWslMoveHandlers(
        () => userDataPath,
        (senderId) => senderId === MAIN_WINDOW_ID,
        undefined,
        () => ({ stopHostCopies })
      )
      expect(await invoke('wslMove:useProjectHereAgain', { kind: 'repo', id: 'repo-1' })).toEqual({
        released: false,
        reason
      })
      expect(stopHostCopies).toHaveBeenCalledOnce()
      expect(listWslMoveCutovers(userDataPath)).toHaveLength(1)
      expect(isWslMoveWindowWriteHeld()).toBe(false)
    }
  )
})
