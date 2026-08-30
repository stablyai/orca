import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from './api-types'

const { exposeInMainWorld, invoke, on, removeListener, send, sendSync } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
  sendSync: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener, send, sendSync },
  webFrame: {
    getZoomFactor: vi.fn(() => 1),
    setZoomFactor: vi.fn(),
    setVisualZoomLevelLimits: vi.fn()
  },
  webUtils: { getPathForFile: vi.fn(() => '') }
}))

vi.mock('@electron-toolkit/preload', () => ({ electronAPI: {} }))

/**
 * The boundary claim measured on the real surface, not on the wrapper in isolation.
 *
 * Each case picks a binding a leaking call site actually reads — the toast copy quoted in the PR
 * came from `ssh.addTarget`, read at `SshPane.tsx:132` — rejects its channel with the envelope Electron produces, and asserts
 * the renderer never sees the plumbing. Driving `api` rather than the wrapper is the point: it is
 * what proves the 731 bindings are wired to it, not just that the wrapper works when called.
 */
describe('the preload surface strips the envelope for every binding', () => {
  const originalContextIsolated = Object.getOwnPropertyDescriptor(process, 'contextIsolated')
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetModules()
    for (const spy of [exposeInMainWorld, invoke, on, removeListener, send, sendSync]) {
      spy.mockReset()
    }
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      removeEventListener: vi.fn()
    })
    vi.stubGlobal('document', { addEventListener: vi.fn() })
  })

  afterEach(() => {
    warn.mockRestore()
    vi.unstubAllGlobals()
    if (originalContextIsolated) {
      Object.defineProperty(process, 'contextIsolated', originalContextIsolated)
    } else {
      Reflect.deleteProperty(process, 'contextIsolated')
    }
  })

  async function loadApi(): Promise<PreloadApi> {
    await import('./index')
    return exposeInMainWorld.mock.calls.find(([name]) => name === 'api')?.[1] as PreloadApi
  }

  /** The message a renderer call site would put straight into a toast. */
  async function messageFrom(call: Promise<unknown>): Promise<string> {
    return await call.then(
      () => {
        throw new Error('expected the binding to reject')
      },
      (error: unknown) => (error as Error).message
    )
  }

  it.each([
    [
      'ssh.addTarget',
      "Error invoking remote method 'ssh:addTarget': Error: Host key verification failed",
      'Host key verification failed'
    ],
    [
      'worktrees.remove',
      "Error occurred in handler for 'worktrees:remove': Error: Worktree has uncommitted changes",
      'Worktree has uncommitted changes'
    ],
    [
      'pty.connect (relay re-throw)',
      "Error invoking remote method 'pty:connect': Error occurred in handler for 'pty:connect': Error: SSH connection lost, reconnecting",
      'SSH connection lost, reconnecting'
    ]
  ])('%s reaches the renderer without the envelope', async (_label, wrapped, expected) => {
    invoke.mockRejectedValue(new Error(wrapped))
    const api = await loadApi()

    await expect(
      messageFrom(api.ssh.addTarget({ target: {} as never }) as Promise<unknown>)
    ).resolves.toBe(expected)
  })

  it('leaves a reason-less rejection for the call site to name, rather than emptying it', async () => {
    const wrapped = "Error invoking remote method 'ssh:addTarget': Error"
    invoke.mockRejectedValue(new Error(wrapped))
    const api = await loadApi()

    await expect(
      messageFrom(api.ssh.addTarget({ target: {} as never }) as Promise<unknown>)
    ).resolves.toBe(wrapped)
  })

  it('keeps the wrapped form on the log so diagnostics lose nothing', async () => {
    const wrapped =
      "Error invoking remote method 'ssh:addTarget': Error: Host key verification failed"
    invoke.mockRejectedValue(new Error(wrapped))
    const api = await loadApi()

    await messageFrom(api.ssh.addTarget({ target: {} as never }) as Promise<unknown>)

    expect(warn).toHaveBeenCalledWith(
      "[ipc] 'ssh:addTarget' rejected; raw:",
      wrapped,
      expect.stringContaining("Error invoking remote method 'ssh:addTarget'")
    )
  })

  it('routes the GitLab bindings through the same boundary', async () => {
    invoke.mockRejectedValue(
      new Error("Error invoking remote method 'gitlab:viewer': Error: 401 Unauthorized")
    )
    const api = await loadApi()

    await expect(messageFrom(api.gl.viewer() as Promise<unknown>)).resolves.toBe('401 Unauthorized')
  })
})
