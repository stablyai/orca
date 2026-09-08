import { describe, expect, it, vi, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'
import type * as ChildProcess from 'node:child_process'
import {
  handleBrowserClick,
  handleBrowserEval,
  handleBrowserGoto,
  handleBrowserKeypress,
  handleBrowserMouseDown,
  handleBrowserMouseMove,
  handleBrowserMouseUp,
  handleBrowserMouseWheel,
  handleBrowserProfileClearDefaultCookies,
  handleBrowserProfileDetectBrowsers,
  handleBrowserSnapshot,
  handleBrowserTabClose,
  handleBrowserTabCreate,
  handleBrowserViewport
} from './browser-handler'
import type { AgentLogger } from './agent-logger'
import type { DetectedBrowser } from './browser-profile-detect'

// Why mock node:child_process (not agent-browser's CLI itself): this suite
// verifies browser-handler.ts's own contract — arg construction, envelope
// parsing, error mapping, session-cleanup branching — without requiring a
// real Chrome/Chromium binary in the test/CI sandbox (a real headless
// integration pass, if a browser is available, belongs in a separate file).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return { ...actual, execFile: vi.fn() }
})
const execFileMock = vi.mocked(execFile)

const detectInstalledBrowsersOnHostMock = vi.fn<() => DetectedBrowser[]>()
vi.mock('./browser-profile-detect', () => ({
  detectInstalledBrowsersOnHost: () => detectInstalledBrowsersOnHostMock()
}))

const LOG: AgentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
}

type ExecFileArgs = [
  string,
  string[],
  { encoding: string; timeout: number; env: NodeJS.ProcessEnv },
  (error: Error | null, stdout: string, stderr: string) => void
]

function respondJson(data: unknown): void {
  const [, , , callback] = execFileMock.mock.calls.at(-1) as unknown as ExecFileArgs
  callback(null, JSON.stringify({ success: true, data, error: null }), '')
}

function respondCliError(message: string): void {
  const [, , , callback] = execFileMock.mock.calls.at(-1) as unknown as ExecFileArgs
  callback(null, JSON.stringify({ success: false, data: null, error: message }), '')
}

function respondSpawnError(message: string): void {
  const [, , , callback] = execFileMock.mock.calls.at(-1) as unknown as ExecFileArgs
  callback(new Error(message), '', '')
}

function lastArgs(): string[] {
  const [, args] = execFileMock.mock.calls.at(-1) as unknown as ExecFileArgs
  return args
}

function lastEnv(): NodeJS.ProcessEnv {
  const [, , options] = execFileMock.mock.calls.at(-1) as unknown as ExecFileArgs
  return options.env
}

beforeEach(() => {
  execFileMock.mockClear()
})

// handleBrowserTabClose chains up to 3 sequential runBrowserCommand() calls
// (close -> list -> maybe close again), each hop separated by several
// microtask ticks (promise resolution + two nested async-function resumes)
// rather than one. Poll instead of assuming a fixed number of ticks.
async function waitForCallCount(count: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (execFileMock.mock.calls.length >= count) {
      return
    }
    await Promise.resolve()
  }
  throw new Error(`execFile was not called ${count} times`)
}

describe('browser-handler — arg construction and session scoping', () => {
  it('handleBrowserGoto builds `open <url> --session <worktree> --json`', async () => {
    const promise = handleBrowserGoto(1, { worktree: 'wt-1', url: 'https://example.com' }, LOG)
    await Promise.resolve()
    expect(lastArgs().slice(1)).toEqual([
      'open',
      'https://example.com',
      '--session',
      'wt-1',
      '--json'
    ])
    respondJson({ title: 'Example', url: 'https://example.com/' })
    const response = await promise
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { title: 'Example', url: 'https://example.com/' }
    })
  })

  it('sets AGENT_BROWSER_IDLE_TIMEOUT_MS on every invocation so the daemon self-reaps', async () => {
    const promise = handleBrowserGoto(1, { worktree: 'wt-1', url: 'https://example.com' }, LOG)
    await Promise.resolve()
    expect(Number(lastEnv().AGENT_BROWSER_IDLE_TIMEOUT_MS)).toBeGreaterThan(0)
    respondJson({ title: '', url: '' })
    await promise
  })

  it('handleBrowserSnapshot passes raw CLI data through unchanged', async () => {
    const promise = handleBrowserSnapshot(2, { worktree: 'wt-1' }, LOG)
    await Promise.resolve()
    expect(lastArgs().slice(1, 2)).toEqual(['snapshot'])
    respondJson({
      snapshot: '- heading',
      refs: { e1: { role: 'heading', name: 'Hi' } },
      origin: 'https://x'
    })
    const response = await promise
    expect(response).toMatchObject({
      result: { snapshot: '- heading', origin: 'https://x' }
    })
  })

  it('handleBrowserClick shapes {clicked}', async () => {
    const promise = handleBrowserClick(3, { worktree: 'wt-1', element: '@e2' }, LOG)
    await Promise.resolve()
    expect(lastArgs().slice(1, 3)).toEqual(['click', '@e2'])
    respondJson({ clicked: '@e2' })
    const response = await promise
    expect(response).toEqual({ jsonrpc: '2.0', id: 3, result: { clicked: '@e2' } })
  })

  it('handleBrowserEval wraps the raw eval result as {result}', async () => {
    const promise = handleBrowserEval(4, { worktree: 'wt-1', expression: '1+1' }, LOG)
    await Promise.resolve()
    expect(lastArgs().slice(1, 3)).toEqual(['eval', '1+1'])
    respondJson(2)
    const response = await promise
    expect(response).toEqual({ jsonrpc: '2.0', id: 4, result: { result: 2 } })
  })

  it('handleBrowserKeypress builds `press <key>`', async () => {
    const promise = handleBrowserKeypress(5, { worktree: 'wt-1', key: 'Tab' }, LOG)
    await Promise.resolve()
    expect(lastArgs().slice(1, 3)).toEqual(['press', 'Tab'])
    respondJson({ pressed: 'Tab' })
    await promise
  })

  it('handleBrowserMouseMove builds `mouse move <x> <y>`', async () => {
    const promise = handleBrowserMouseMove(6, { worktree: 'wt-1', x: 10, y: 20 }, LOG)
    await Promise.resolve()
    expect(lastArgs().slice(1, 5)).toEqual(['mouse', 'move', '10', '20'])
    respondJson({ moved: true })
    await promise
  })

  it('handleBrowserMouseDown omits the button arg when not provided', async () => {
    const promise = handleBrowserMouseDown(7, { worktree: 'wt-1' }, LOG)
    await Promise.resolve()
    expect(lastArgs().slice(1, 3)).toEqual(['mouse', 'down'])
    respondJson({ pressed: true })
    await promise
  })

  it('handleBrowserMouseUp includes the button arg when provided', async () => {
    const promise = handleBrowserMouseUp(8, { worktree: 'wt-1', button: 'right' }, LOG)
    await Promise.resolve()
    expect(lastArgs().slice(1, 4)).toEqual(['mouse', 'up', 'right'])
    respondJson({ released: true })
    await promise
  })

  it('handleBrowserMouseWheel builds `mouse wheel <dy> [dx]`', async () => {
    const promise = handleBrowserMouseWheel(9, { worktree: 'wt-1', dy: 100, dx: 5 }, LOG)
    await Promise.resolve()
    expect(lastArgs().slice(1, 5)).toEqual(['mouse', 'wheel', '100', '5'])
    respondJson({ scrolled: true })
    await promise
  })

  it('handleBrowserViewport builds `set viewport <w> <h>`', async () => {
    const promise = handleBrowserViewport(10, { worktree: 'wt-1', width: 800, height: 600 }, LOG)
    await Promise.resolve()
    expect(lastArgs().slice(1, 5)).toEqual(['set', 'viewport', '800', '600'])
    respondJson({ width: 800, height: 600, deviceScaleFactor: 1, mobile: false })
    await promise
  })

  it('handleBrowserTabCreate builds `tab new` and aliases tabId to browserPageId', async () => {
    const promise = handleBrowserTabCreate(11, { worktree: 'wt-1' }, LOG)
    await Promise.resolve()
    expect(lastArgs().slice(1, 3)).toEqual(['tab', 'new'])
    respondJson({ tabId: 't2', total: 2, url: 'about:blank' })
    const response = await promise
    expect(response).toMatchObject({ result: { tabId: 't2', browserPageId: 't2' } })
  })
})

describe('browser-handler — validation and error mapping', () => {
  it('rejects a missing worktree selector without spawning agent-browser', async () => {
    const response = await handleBrowserGoto(1, { url: 'https://example.com' }, LOG)
    expect(execFileMock).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      error: { message: expect.stringContaining('BROWSER_NO_WORKTREE') }
    })
  })

  it('rejects missing required op params without spawning agent-browser', async () => {
    const response = await handleBrowserGoto(1, { worktree: 'wt-1' }, LOG)
    expect(execFileMock).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      error: { message: expect.stringContaining('BROWSER_MISSING_ARGS') }
    })
  })

  it('maps a CLI-reported failure to BROWSER_COMMAND_FAILED', async () => {
    const promise = handleBrowserGoto(1, { worktree: 'wt-1', url: 'https://example.com' }, LOG)
    await Promise.resolve()
    respondCliError('navigation timed out')
    const response = await promise
    expect(response).toMatchObject({
      error: { message: expect.stringContaining('BROWSER_COMMAND_FAILED') }
    })
  })

  it('maps a "no usable browser" failure to BROWSER_ENGINE_UNAVAILABLE — the Chrome-not-installed operational error', async () => {
    const promise = handleBrowserGoto(1, { worktree: 'wt-1', url: 'https://example.com' }, LOG)
    await Promise.resolve()
    respondCliError('No usable browser found on this system.')
    const response = await promise
    expect(response).toMatchObject({
      error: { message: expect.stringContaining('BROWSER_ENGINE_UNAVAILABLE') }
    })
  })

  it('maps a spawn-level failure mentioning a missing Chrome executable to BROWSER_ENGINE_UNAVAILABLE', async () => {
    const promise = handleBrowserGoto(1, { worktree: 'wt-1', url: 'https://example.com' }, LOG)
    await Promise.resolve()
    respondSpawnError("Failed to launch chrome: executable doesn't exist")
    const response = await promise
    expect(response).toMatchObject({
      error: { message: expect.stringContaining('BROWSER_ENGINE_UNAVAILABLE') }
    })
  })

  it('maps a generic spawn failure to BROWSER_COMMAND_FAILED', async () => {
    const promise = handleBrowserGoto(1, { worktree: 'wt-1', url: 'https://example.com' }, LOG)
    await Promise.resolve()
    respondSpawnError('ETIMEDOUT')
    const response = await promise
    expect(response).toMatchObject({
      error: { message: expect.stringContaining('BROWSER_COMMAND_FAILED') }
    })
  })
})

describe('browser-handler — tabClose session-teardown model', () => {
  it('closes only the tab (not the session) when other tabs remain', async () => {
    const promise = handleBrowserTabClose(1, { worktree: 'wt-1', page: 't1' }, LOG)
    await waitForCallCount(1)
    expect(lastArgs().slice(1, 4)).toEqual(['tab', 'close', 't1'])
    respondJson({ closed: true, tabId: 't1' })

    await waitForCallCount(2)
    expect(lastArgs().slice(1, 3)).toEqual(['tab', 'list'])
    respondJson({ tabs: [{ tabId: 't2' }] })

    const response = await promise
    expect(response).toEqual({ jsonrpc: '2.0', id: 1, result: { closed: true, tabId: 't1' } })
    // Why: only 2 calls (tab close, tab list) — no teardown `close` call
    // should happen while a tab remains.
    expect(execFileMock).toHaveBeenCalledTimes(2)
  })

  it('tears down the whole session once the last tab closes, freeing the host Chrome process', async () => {
    const promise = handleBrowserTabClose(1, { worktree: 'wt-1' }, LOG)
    await waitForCallCount(1)
    expect(lastArgs().slice(1, 3)).toEqual(['tab', 'close'])
    respondJson({ closed: true })

    await waitForCallCount(2)
    expect(lastArgs().slice(1, 3)).toEqual(['tab', 'list'])
    respondJson({ tabs: [] })

    await waitForCallCount(3)
    expect(lastArgs().slice(1, 2)).toEqual(['close'])
    respondJson({ closed: true })

    const response = await promise
    expect(response).toMatchObject({ result: { closed: true } })
    expect(execFileMock).toHaveBeenCalledTimes(3)
  })
})

// TASK-023: this relay is keyed by devServerId, not worktree — the CLI call
// must use the fixed default-session name, never anything derived from
// params.worktree (there is no worktree param on this wire call at all).
describe('browser-handler — profileClearDefaultCookies (dev-server-wide default session)', () => {
  it('invokes `cookies clear` against the fixed default-profile session, not any worktree', async () => {
    const promise = handleBrowserProfileClearDefaultCookies(1, {}, LOG)
    await Promise.resolve()
    expect(lastArgs().slice(1)).toEqual([
      'cookies',
      'clear',
      '--session',
      '__default_browser_profile__',
      '--json'
    ])
    respondJson({ cleared: true })
    const response = await promise
    expect(response).toEqual({ jsonrpc: '2.0', id: 1, result: { cleared: true } })
  })

  it('ignores a params.worktree field entirely — always targets the default session', async () => {
    const promise = handleBrowserProfileClearDefaultCookies(2, { worktree: 'wt-1' }, LOG)
    await Promise.resolve()
    expect(lastArgs()).toContain('__default_browser_profile__')
    expect(lastArgs()).not.toContain('wt-1')
    respondJson({ cleared: true })
    await promise
  })

  it('propagates a CLI failure as a JSON-RPC error', async () => {
    const promise = handleBrowserProfileClearDefaultCookies(3, {}, LOG)
    await Promise.resolve()
    respondCliError('no active session')
    const response = await promise
    expect(response).toMatchObject({
      error: { message: expect.stringContaining('BROWSER_COMMAND_FAILED') }
    })
  })
})

// TASK-024: this handler does not shell out to agent-browser at all — it
// delegates to browser-profile-detect.ts's host-filesystem scan.
describe('browser-handler — profileDetectBrowsers', () => {
  beforeEach(() => {
    detectInstalledBrowsersOnHostMock.mockReset()
  })

  it('returns the detected browsers wrapped as {browsers}, without spawning agent-browser', async () => {
    const detected: DetectedBrowser[] = [
      {
        family: 'chrome',
        label: 'Google Chrome',
        profiles: [{ name: 'Default', directory: 'Default' }],
        selectedProfile: 'Default'
      }
    ]
    detectInstalledBrowsersOnHostMock.mockReturnValue(detected)

    const response = await handleBrowserProfileDetectBrowsers(1, {}, LOG)

    expect(execFileMock).not.toHaveBeenCalled()
    expect(response).toEqual({ jsonrpc: '2.0', id: 1, result: { browsers: detected } })
  })

  it('maps a detection failure to a JSON-RPC error', async () => {
    detectInstalledBrowsersOnHostMock.mockImplementation(() => {
      throw new Error('fs blew up')
    })

    const response = await handleBrowserProfileDetectBrowsers(2, {}, LOG)

    expect(response).toMatchObject({ error: { message: expect.stringContaining('fs blew up') } })
  })
})
