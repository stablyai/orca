import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalHost } from './terminal-host'
import type { SubprocessHandle } from './session'

const killWithDescendantSweepMock = vi.hoisted(() => vi.fn())
vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

function createMockSubprocess(): SubprocessHandle & {
  _onExitCb: ((code: number) => void) | null
} {
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 99999,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => {
      setTimeout(() => onExitCb?.(0), 5)
    }),
    forceKill: vi.fn(() => onExitCb?.(137)),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn(),
    get _onExitCb() {
      return onExitCb
    }
  }
}

describe('TerminalHost agent inference', () => {
  let host: TerminalHost
  let spawnFn: ReturnType<typeof vi.fn>
  let lastSubprocess: ReturnType<typeof createMockSubprocess>

  beforeEach(() => {
    killWithDescendantSweepMock.mockReset()
    spawnFn = vi.fn(() => {
      lastSubprocess = createMockSubprocess()
      return lastSubprocess
    })
    host = new TerminalHost({ spawnSubprocess: spawnFn })
  })

  afterEach(async () => {
    await host.dispose()
  })

  it('infers agent identity from the startup command and forwards it to spawn', async () => {
    const result = await host.createOrAttach({
      sessionId: 'session-1',
      cols: 80,
      rows: 24,
      command: 'powershell -File C:\\tools\\claude.ps1',
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

    expect(spawnFn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        command: 'powershell -File C:\\tools\\claude.ps1',
        launchAgent: 'claude'
      })
    )
    expect(result.launchAgent).toBe('claude')
  })

  it('routes command-inferred immediate agent kill through the descendant sweep', async () => {
    await host.createOrAttach({
      sessionId: 'agent-inferred',
      cols: 80,
      rows: 24,
      command: 'powershell -File C:\\tools\\claude.ps1',
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    lastSubprocess.forceKill = vi.fn()

    const killing = host.kill('agent-inferred', { immediate: true })

    expect(killWithDescendantSweepMock).toHaveBeenCalledWith(
      99999,
      expect.any(Function),
      expect.objectContaining({ ownsRoot: expect.any(Function) })
    )
    expect(lastSubprocess.forceKill).not.toHaveBeenCalled()

    const finish = killWithDescendantSweepMock.mock.calls[0][1] as () => void
    finish()
    expect(lastSubprocess.forceKill).toHaveBeenCalledOnce()

    lastSubprocess._onExitCb?.(137)
    await killing
    expect(lastSubprocess.dispose).toHaveBeenCalledOnce()
  })
})
