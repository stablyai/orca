// What the window's own send returned must reach the RPC result a CLI prints from.
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { setRuntimeDesktopSurface } from '../runtime/construction/runtime-desktop-surface'
import { partialRuntimeStore } from '../runtime/construction/test-context/runtime-store-partial-fixture'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { TERMINAL_LIFECYCLE_METHODS } from '../runtime/rpc/methods/terminal/terminal-lifecycle-methods'
import { WORKTREE_METHODS } from '../runtime/rpc/methods/workspaces/worktree'
import { registerRuntimeWindowLifecycle } from './runtime-window-lifecycle'

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  return { ipcMain: new Emitter() }
})

const REPO = { id: 'repo', path: '/repo', displayName: 'repo', badgeColor: 'blue', addedAt: 1 }
const WORKTREE_ID = 'repo::/scan'
const WINDOW_ID = 7
const LEAF = { tabId: 'tab', worktreeId: WORKTREE_ID, leafId: 'leaf' }

function navigationRuntime(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(
    partialRuntimeStore({
      getRepos: () => [REPO],
      getRepo: (id) => (id === REPO.id ? REPO : undefined)
    })
  )
  // Only lookups (git, the terminal's leaf), the VM wake and the mail database are stubbed; the
  // activation, the focus and the window's notices run for real.
  Object.assign(runtime, {
    resolveGitWorktreeSelector: async () => ({ id: WORKTREE_ID, repoId: REPO.id }),
    wakeWorkspaceVm: async () => null,
    getExistingOrchestrationDb: () => null,
    getLivePtyForHandle: () => null,
    getLiveLeafForHandle: () => ({ leaf: LEAF })
  })
  return runtime
}

/** A window whose renderer frame accepts sends until `gone` is set. */
function openWindow(runtime: OrcaRuntimeService) {
  const state = { gone: false, sent: [] as string[] }
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (channel: string) => {
      if (state.gone) {
        throw new Error('Render frame was disposed')
      }
      state.sent.push(channel)
    },
    getURL: () => 'file:///index.html',
    isLoadingMainFrame: () => false,
    mainFrame: {}
  })
  const window = Object.assign(new EventEmitter(), {
    id: WINDOW_ID,
    isDestroyed: () => false,
    webContents
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lifecycle reads only id, isDestroyed, on and these webContents members.
  registerRuntimeWindowLifecycle(window as never, runtime)
  runtime.markGraphReady(WINDOW_ID)
  return state
}

function call(runtime: OrcaRuntimeService, method: string, params: Record<string, unknown>) {
  return new RpcDispatcher({
    runtime,
    methods: [...WORKTREE_METHODS, ...TERMINAL_LIFECYCLE_METHODS]
  })
    .dispatch({ id: method, authToken: 'local', method, params })
    .then((response) => (response.ok ? response.result : response.error))
}

const activate = (runtime: OrcaRuntimeService) =>
  call(runtime, 'worktree.activate', { worktree: `id:${WORKTREE_ID}`, navigation: 'host' })
const focus = (runtime: OrcaRuntimeService) =>
  call(runtime, 'terminal.focus', { terminal: 'term_scan', navigation: 'host' })

beforeEach(() => {
  setRuntimeDesktopSurface({
    showNotification: () => false,
    hasWindow: (id) => id === WINDOW_ID,
    hasLiveRenderer: () => true,
    sendToWindow: () => true,
    requestRenderer: () => Promise.reject(new Error('unexpected renderer request'))
  })
})

afterEach(() => {
  setRuntimeDesktopSurface(null)
})

it('reports a sent workspace request, and a refused one, from the window through the RPC', async () => {
  const runtime = navigationRuntime()
  const window = openWindow(runtime)
  expect(await activate(runtime)).toMatchObject({
    worktreeId: WORKTREE_ID,
    hostWindow: 'requested'
  })
  expect(window.sent).toContain('ui:activateWorktree')

  // The window is still there, but its frame refuses the send.
  window.gone = true
  expect(await activate(runtime)).toMatchObject({ hostWindow: 'unavailable' })
})

it('reports no window when a headless host has none to send to', async () => {
  const runtime = navigationRuntime()
  runtime.attachWindow(HEADLESS_RUNTIME_WINDOW_ID)
  runtime.markGraphReady(HEADLESS_RUNTIME_WINDOW_ID)
  expect(await activate(runtime)).toMatchObject({ worktreeId: WORKTREE_ID, hostWindow: 'none' })
})

it('does not report a terminal focused when the window refused the send', async () => {
  const runtime = navigationRuntime()
  const window = openWindow(runtime)
  expect(await focus(runtime)).toMatchObject({ focus: { handle: 'term_scan', navigated: true } })
  expect(window.sent).toContain('ui:focusTerminal')

  window.gone = true
  expect(await focus(runtime)).toMatchObject({ focus: { handle: 'term_scan', navigated: false } })
})
