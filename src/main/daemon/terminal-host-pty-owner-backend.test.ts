import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from './session'
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

  it('uses the spawned native shell over stale requested WSL metadata', async () => {
    const replyProducers: string[] = []
    const onData = vi.fn((data: string) => {
      if (data === '\x1b]10;?\x07') {
        replyProducers.push('renderer')
        host.write('owner-test', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\')
      }
    })
    const subprocess = await createSession('powershell.exe', 'Ubuntu', onData)

    subprocess.emitData('\x1b]10;?\x07')

    expect(replyProducers).toEqual([])
    expect(onData).toHaveBeenCalledWith('', '\x1b]10;?\x07'.length, true, '\x1b]10;?\x07'.length)
    expect(subprocess.write).not.toHaveBeenCalled()
  })

  it('keeps replies for an actually spawned WSL shell', async () => {
    const reply = '\x1b]10;rgb:ffff/ffff/ffff\x1b\\'
    const replyProducers: string[] = []
    const onData = vi.fn((data: string) => {
      if (data === '\x1b]10;?\x07') {
        replyProducers.push('renderer')
        host.write('owner-test', reply)
      }
    })
    const subprocess = await createSession('wsl.exe', undefined, onData)

    subprocess.emitData('\x1b]10;?\x07')

    expect(replyProducers).toEqual(['renderer'])
    expect(subprocess.write).toHaveBeenCalledWith(reply)
  })
})
