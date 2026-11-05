import './mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as WslModule from '../wsl/discovery/distro-catalog'

vi.mock('../wsl/discovery/distro-catalog', async (importOriginal) => ({
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
})
