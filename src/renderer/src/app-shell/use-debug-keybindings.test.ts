// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DebugSnapshot } from '../../../preload/api/debug-api'
import type { DebugOpenRunAndDebugDetail } from './use-debug-keybindings'
import type * as DebugSessionModule from '@/lib/debug/use-debug-session'
import { WORKTREE_ID_SEPARATOR } from '../../../shared/worktree/id'

const WORKTREE_ID = `repo-1${WORKTREE_ID_SEPARATOR}/work/app`

const mocks = await vi.hoisted(async () => {
  const { create } = await import('zustand')
  return {
    store: create<Record<string, unknown>>(() => ({}))
  }
})

vi.mock('@/store', () => ({ useAppStore: mocks.store }))
vi.mock('@/lib/debug/debug-client', () => ({ debugClient: {} }))
vi.mock('@/lib/debug/use-debug-session', () => ({ debugSessionStore: {} }))
vi.mock('./app-window-chrome', () => ({ shortcutPlatform: 'linux' }))

const { createDebugSessionStore } = await vi.importActual<typeof DebugSessionModule>(
  '@/lib/debug/use-debug-session'
)
const { useDebugKeybindings } = await import('./use-debug-keybindings')

function snapshot(overrides: Partial<DebugSnapshot> = {}): DebugSnapshot {
  return {
    seq: 1,
    worktreePath: '/real/app',
    status: 'idle',
    configName: null,
    adapterId: null,
    capabilities: {},
    stopped: null,
    threads: [],
    breakpoints: [],
    exceptionFilters: { available: [], enabled: [] },
    lastError: null,
    ...overrides
  }
}

const STOPPED = snapshot({
  seq: 2,
  status: 'stopped',
  stopped: { reason: 'breakpoint', threadId: 7, allThreadsStopped: true },
  threads: [{ id: 7, name: 'main' }]
})

function fakeClient(current: DebugSnapshot) {
  const ok = <T>(value: T) => vi.fn().mockResolvedValue({ ok: true, value })
  return {
    snapshot: ok(current),
    previewLaunch: ok({
      expectedHash: 'hash-1',
      approved: { repo: true, adapter: true, launch: true }
    }),
    start: ok(snapshot({ seq: 3, status: 'running' })),
    stop: ok(current),
    restart: ok(current),
    continue: ok(null),
    pause: ok(null),
    next: ok(null),
    stepIn: ok(null),
    stepOut: ok(null),
    listBreakpoints: ok([]),
    addBreakpoint: ok({}),
    removeBreakpoint: ok(null)
  }
}

const TARGET = { repoId: 'repo-1', worktreePath: '/work/app' }
const roots: ReturnType<typeof createRoot>[] = []
let client: ReturnType<typeof fakeClient>
let store: ReturnType<typeof createDebugSessionStore>
let openRunAndDebug: ReturnType<typeof vi.fn<(detail: DebugOpenRunAndDebugDetail) => void>>

async function mount(current: DebugSnapshot): Promise<void> {
  client = fakeClient(current)
  store = createDebugSessionStore({
    onState: () => () => {},
    onOutput: () => () => {},
    stackTrace: vi.fn()
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  function Host(): null {
    useDebugKeybindings({ client, store, openRunAndDebug })
    return null
  }
  await act(async () => root.render(createElement(Host)))
}

async function press(key: string, init: KeyboardEventInit = {}, target: Element = document.body) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true, ...init })
    )
  })
}

function element(html: string, selector: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  const found = host.querySelector<HTMLElement>(selector)
  if (!found) {
    throw new Error(selector)
  }
  return found
}

beforeEach(() => {
  openRunAndDebug = vi.fn()
  mocks.store.setState({
    keybindings: {},
    activeWorktreeId: WORKTREE_ID,
    worktreesByRepo: { 'repo-1': [{ id: WORKTREE_ID, path: '/work/app' }] },
    activeFileId: 'file-a',
    openFiles: [
      {
        id: 'file-a',
        filePath: '/work/app/src/main.py',
        relativePath: 'src/main.py',
        worktreeId: WORKTREE_ID,
        mode: 'edit'
      }
    ],
    editorCursorLine: { 'file-a': 12 }
  })
})

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount()
    }
  })
  document.body.innerHTML = ''
})

describe('useDebugKeybindings', () => {
  it.each([
    ['F5', {}, 'continue'],
    ['F10', {}, 'next'],
    ['F11', { shiftKey: false }, 'stepIn'],
    ['F11', { shiftKey: true }, 'stepOut']
  ] as const)('%s %o while stopped calls %s on the stopped thread', async (key, init, call) => {
    await mount(STOPPED)
    // Linux leaves Step Into unbound for the native fullscreen key; bind it as a user would.
    mocks.store.setState({ keybindings: { 'debug.stepInto': ['F11'] } })
    await press(key, init)
    expect(client[call]).toHaveBeenCalledWith({ ...TARGET, threadId: 7 })
  })

  it('stops with Shift+F5 and restarts with Ctrl+Shift+F5', async () => {
    await mount(STOPPED)
    await press('F5', { shiftKey: true })
    expect(client.stop).toHaveBeenCalledWith(TARGET)
    await press('F5', { shiftKey: true, ctrlKey: true })
    expect(client.restart).toHaveBeenCalledWith(TARGET)
    expect(client.continue).not.toHaveBeenCalled()
  })

  it('pauses a running session with F6', async () => {
    await mount(snapshot({ status: 'running', threads: [{ id: 3, name: 'main' }] }))
    await press('F6')
    expect(client.pause).toHaveBeenCalledWith({ ...TARGET, threadId: 3 })
  })

  it('F5 with no session starts the selected, approved configuration', async () => {
    await mount(snapshot())
    store.selectConfiguration('/real/app', 'Run app')
    await press('F5')
    expect(client.previewLaunch).toHaveBeenCalledWith({ ...TARGET, configName: 'Run app' })
    expect(client.start).toHaveBeenCalledWith({
      ...TARGET,
      configName: 'Run app',
      expectedHash: 'hash-1'
    })
    expect(store.getState('/real/app').snapshot?.status).toBe('running')
    expect(openRunAndDebug).not.toHaveBeenCalled()
  })

  it('F5 opens Run and Debug with the confirmation when the configuration is not approved', async () => {
    await mount(snapshot())
    client.previewLaunch.mockResolvedValue({
      ok: true,
      value: { expectedHash: 'h', approved: { repo: true, adapter: true, launch: false } }
    })
    store.selectConfiguration('/real/app', 'Run app')
    await press('F5')
    expect(client.start).not.toHaveBeenCalled()
    expect(openRunAndDebug).toHaveBeenCalledWith({ configName: 'Run app', confirm: true })
  })

  it('F5 opens Run and Debug when no configuration is selected', async () => {
    await mount(snapshot())
    await press('F5')
    expect(client.previewLaunch).not.toHaveBeenCalled()
    expect(openRunAndDebug).toHaveBeenCalledWith({ configName: null, confirm: false })
  })

  it('F9 in the editor adds a breakpoint at the cursor line, then removes it', async () => {
    await mount(snapshot())
    const editor = element('<div class="monaco-editor"><textarea></textarea></div>', 'textarea')
    await press('F9', {}, editor)
    expect(client.addBreakpoint).toHaveBeenCalledWith({
      ...TARGET,
      path: '/work/app/src/main.py',
      line: 12
    })
    client.listBreakpoints.mockResolvedValue({
      ok: true,
      value: [{ id: 'bp-1', path: '/real/app/src/main.py', line: 12 }]
    })
    await press('F9', {}, editor)
    expect(client.removeBreakpoint).toHaveBeenCalledWith({ ...TARGET, id: 'bp-1' })
  })

  it('F9 outside an editor does nothing', async () => {
    await mount(snapshot())
    await press('F9')
    expect(client.listBreakpoints).not.toHaveBeenCalled()
  })

  it.each([
    ['terminal', '<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>'],
    ['browser', '<div data-browser-pane-id="b1"><input /></div>'],
    ['chat', '<div data-native-chat-root><textarea></textarea></div>']
  ])('ignores keys from a %s surface', async (_surface, html) => {
    await mount(STOPPED)
    const target = element(html, 'textarea, input')
    await press('F5', {}, target)
    await press('F10', {}, target)
    expect(client.snapshot).not.toHaveBeenCalled()
    expect(client.continue).not.toHaveBeenCalled()
    expect(client.next).not.toHaveBeenCalled()
  })
})
