import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost } from './terminal-host'

const killWithDescendantSweepMock = vi.hoisted(() => vi.fn())
vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

type TestSubprocess = SubprocessHandle & {
  emitData: (data: string) => void
}

function createSubprocess(shellPath: string): TestSubprocess {
  let onData: ((data: string) => void) | null = null
  let onExit: ((code: number) => void) | null = null
  return {
    pid: 99_999,
    shellPath,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => onExit?.(0)),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => onExit?.(137)),
    signal: vi.fn(),
    onData: (callback) => {
      onData = callback
    },
    onExit: (callback) => {
      onExit = callback
    },
    dispose: vi.fn(),
    emitData: (data) => onData?.(data)
  }
}

describe('TerminalHost PTY owner backend', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  let host: TerminalHost

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(async () => {
    await host?.dispose()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  async function createSession(
    shellPath: string,
    requestedWslDistro?: string,
    onData = vi.fn()
  ): Promise<TestSubprocess> {
    const subprocess = createSubprocess(shellPath)
    host = new TerminalHost({ spawnSubprocess: () => subprocess })
    await host.createOrAttach({
      sessionId: 'owner-test',
      cols: 80,
      rows: 24,
      ...(requestedWslDistro
        ? { shellOverride: 'wsl.exe', terminalWindowsWslDistro: requestedWslDistro }
        : { shellOverride: 'powershell.exe' }),
      streamClient: { onData, onExit: vi.fn() }
    })
    return subprocess
  }

  // Orca's default theme: nothing reported colours for this session.
  const query = '\x1b]10;?\x07'
  const reply = '\x1b]10;rgb:ffff/ffff/ffff\x1b\\'
  // ConPTY echoes a reply with its ESC bytes stripped; wsl.exe's echo shape is unverified.
  const conptyEcho = reply.replaceAll('\x1b', '')

  it('uses the spawned native shell over stale requested WSL metadata', async () => {
    const onData = vi.fn()
    const subprocess = await createSession('powershell.exe', 'Ubuntu', onData)

    subprocess.emitData(query)
    subprocess.emitData(conptyEcho)

    expect(subprocess.write).toHaveBeenCalledWith(reply)
    expect(onData).toHaveBeenCalledWith('', query.length, true, query.length)
    expect(onData).not.toHaveBeenCalledWith(conptyEcho)
  })

  it('treats an actually spawned WSL shell as wsl.exe, not ConPTY', async () => {
    const onData = vi.fn()
    const subprocess = await createSession('wsl.exe', undefined, onData)

    subprocess.emitData(query)
    subprocess.emitData(conptyEcho)

    expect(subprocess.write).toHaveBeenCalledWith(reply)
    expect(onData).toHaveBeenCalledWith(conptyEcho)
  })
})
