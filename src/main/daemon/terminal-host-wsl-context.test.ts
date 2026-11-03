import './mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as WslModule from '../wsl'

vi.mock('../wsl', async (importOriginal) => ({
  ...(await importOriginal<typeof WslModule>()),
  getDefaultWslDistro: () => 'Ubuntu'
}))

import { TerminalHost } from './terminal-host'
import type { SubprocessHandle } from './session-subprocess-handle'
import { PtyPreListenerEvents } from './pty-subprocess/pre-listener-events'

function createSubprocess(): SubprocessHandle {
  let onExit: ((code: number) => void) | undefined
  return {
    pid: 123,
    getForegroundProcess: () => null,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => onExit?.(0)),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => onExit?.(137)),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((callback: (code: number) => void) => {
      onExit = callback
    }),
    dispose: vi.fn()
  }
}

describe('TerminalHost WSL context', () => {
  let host: TerminalHost | undefined

  afterEach(async () => {
    await host?.dispose()
  })

  it('returns the first creator context on conflicting later attaches', async () => {
    const spawnSubprocess = vi.fn(() => createSubprocess())
    host = new TerminalHost({ spawnSubprocess })
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const created = await host.createOrAttach({
        sessionId: 'session-wsl',
        cols: 80,
        rows: 24,
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin',
        terminalWindowsWslDistro: 'Debian',
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      const attached = await host.createOrAttach({
        sessionId: 'session-wsl',
        cols: 80,
        rows: 24,
        terminalWindowsWslDistro: 'Debian',
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      expect(created.wslDistro).toBe('Ubuntu')
      expect(attached.wslDistro).toBe('Ubuntu')
      expect(spawnSubprocess).toHaveBeenCalledOnce()
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('persists the resolved default distro across daemon attaches', async () => {
    const spawnSubprocess = vi.fn(() => createSubprocess())
    host = new TerminalHost({ spawnSubprocess })
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const created = await host.createOrAttach({
        sessionId: 'session-default-wsl',
        cols: 80,
        rows: 24,
        cwd: 'C:\\Users\\jin\\repo',
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: null,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      const attached = await host.createOrAttach({
        sessionId: 'session-default-wsl',
        cols: 80,
        rows: 24,
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Debian',
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      expect(created.wslDistro).toBe('Ubuntu')
      expect(attached.wslDistro).toBe('Ubuntu')
      expect(spawnSubprocess).toHaveBeenCalledOnce()
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('records a guest root the PTY printed before the session subscribed', async () => {
    // ConPTY's startup check and spawn bookkeeping run before the session exists; output
    // from then waits in the pre-listener buffer and is replayed as the session subscribes.
    const events = new PtyPreListenerEvents()
    const boot = '0b1d2c3e-4f50-4617-8293-a4b5c6d7e8f9'
    events.acceptData(`\x1b]777;orca-wsl-root:4242:${boot}:98765\x07$ `)
    const spawnSubprocess = vi.fn(() => ({
      ...createSubprocess(),
      onData: (callback: (data: string) => void) => events.onData(callback)
    }))
    host = new TerminalHost({ spawnSubprocess })
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      await host.createOrAttach({
        sessionId: 'session-early-root',
        cols: 80,
        rows: 24,
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu',
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      expect(host.listSessions()).toEqual([
        expect.objectContaining({
          sessionId: 'session-early-root',
          wslGuestRoot: { pid: 4242, startTime: `${boot}:98765` }
        })
      ])
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('returns authoritative null when a native session is attached with a WSL preference', async () => {
    const spawnSubprocess = vi.fn(() => createSubprocess())
    host = new TerminalHost({ spawnSubprocess })
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const created = await host.createOrAttach({
        sessionId: 'session-native',
        cols: 80,
        rows: 24,
        cwd: '\\\\server\\share\\repo',
        shellOverride: 'powershell.exe',
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      const attached = await host.createOrAttach({
        sessionId: 'session-native',
        cols: 80,
        rows: 24,
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu',
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      expect(created.wslDistro).toBeNull()
      expect(attached.wslDistro).toBeNull()
      expect(spawnSubprocess).toHaveBeenCalledOnce()
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })
})
