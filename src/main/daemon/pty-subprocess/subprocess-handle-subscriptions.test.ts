import { describe, expect, it, vi } from 'vitest'
import type { TerminalProcess } from '../../../shared/terminal-process'
import { createDaemonPtySubprocessHandle } from './subprocess-handle'

function createFixture(options: { synchronousExit?: boolean; synchronousData?: string } = {}) {
  let physicalExit: (event: { exitCode: number; signal?: number }) => void = () => {}
  const dataDispose = vi.fn()
  const exitDispose = vi.fn()
  const process: TerminalProcess = {
    pid: 999_999_999,
    process: 'zsh',
    cols: 80,
    rows: 24,
    clear: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    onData: (listener) => {
      if (options.synchronousData) {
        listener(options.synchronousData)
      }
      return { dispose: dataDispose }
    },
    onExit: (listener) => {
      physicalExit = listener
      if (options.synchronousExit) {
        listener({ exitCode: 0 })
      }
      return { dispose: exitDispose }
    }
  }
  const handle = createDaemonPtySubprocessHandle({
    process,
    shellPath: '/bin/zsh',
    spawnCwd: '/tmp',
    env: {},
    startupCommandDeliveredInShellArgs: false,
    reportsChildExitStatus: true,
    sessionId: 'subscription-test',
    startupAgentRecognition: null
  })
  return {
    handle,
    physicalExit: (event: { exitCode: number; signal?: number } = { exitCode: 0 }) =>
      physicalExit(event),
    dataDispose,
    exitDispose
  }
}

describe('daemon native PTY subscription ownership', () => {
  it('retains native exit observation until physical exit, even when disposal was requested', () => {
    const fixture = createFixture()
    fixture.handle.dispose()
    expect(fixture.exitDispose).not.toHaveBeenCalled()
    fixture.physicalExit()
    expect(fixture.dataDispose).toHaveBeenCalledOnce()
    expect(fixture.exitDispose).toHaveBeenCalledOnce()
    fixture.handle.dispose()
    expect(fixture.exitDispose).toHaveBeenCalledOnce()
  })

  it('releases both native subscriptions when an exit listener disposes reentrantly', () => {
    const fixture = createFixture()
    fixture.handle.onExit(() => fixture.handle.dispose())
    fixture.physicalExit()
    expect(fixture.dataDispose).toHaveBeenCalledOnce()
    expect(fixture.exitDispose).toHaveBeenCalledOnce()
  })

  it('buffers synchronous registration events and still releases each subscription once', () => {
    const fixture = createFixture({ synchronousData: 'last output', synchronousExit: true })
    const data = vi.fn()
    const exit = vi.fn(() => fixture.handle.dispose())
    fixture.handle.onData(data)
    fixture.handle.onExit(exit)
    expect(data).toHaveBeenCalledWith('last output')
    expect(exit).toHaveBeenCalledOnce()
    expect(fixture.dataDispose).toHaveBeenCalledOnce()
    expect(fixture.exitDispose).toHaveBeenCalledOnce()
  })
  it('preserves signal provenance when a native exit also carries a zero exit code', () => {
    const fixture = createFixture()
    const onExit = vi.fn(() => fixture.handle.dispose())
    fixture.handle.onExit(onExit)
    fixture.physicalExit({ exitCode: 0, signal: 9 })
    expect(onExit).toHaveBeenCalledWith(0, { kind: 'signaled', signal: 9 })
  })
})
