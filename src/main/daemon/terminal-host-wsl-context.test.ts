import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalHost } from './terminal-host'
import type { SubprocessHandle } from './session'
import { resolveWslSessionContext } from './wsl-session-context'

function createSubprocess(): SubprocessHandle {
  let onExit: ((code: number) => void) | undefined
  return {
    pid: 123,
    getForegroundProcess: () => null,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => onExit?.(0)),
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

  it('uses a remembered distro only when the selected shell is WSL', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      expect(
        resolveWslSessionContext({
          cwd: 'C:\\Users\\jin\\repo',
          shellOverride: 'powershell.exe',
          terminalWindowsWslDistro: 'Ubuntu'
        })
      ).toBeUndefined()
      expect(
        resolveWslSessionContext({
          cwd: '\\\\server\\share\\repo',
          shellOverride: 'powershell.exe',
          terminalWindowsWslDistro: 'Ubuntu'
        })
      ).toBeUndefined()
      expect(
        resolveWslSessionContext({
          cwd: 'C:\\Users\\jin\\repo',
          shellOverride: 'wsl.exe',
          terminalWindowsWslDistro: ' Ubuntu '
        })
      ).toEqual({ distro: 'Ubuntu', treatPosixCwdAsWsl: true })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })
})
