import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type * as pty from 'node-pty'
import { createDaemonPtySubprocessHandle } from './pty-subprocess/subprocess-handle'

vi.mock('../pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: () => {
    throw new Error('Unexpected native termination')
  }
}))
vi.mock('../pty/posix-pty-foreground-group', () => ({
  signalPosixPtyForegroundGroup: () => {
    throw new Error('Unexpected native signal')
  }
}))

function nativePort() {
  const data = new EventEmitter()
  const exit = new EventEmitter()
  const process_ = {
    pid: 0,
    cols: 80,
    rows: 24,
    process: 'audit-shell',
    handleFlowControl: false,
    onData(listener: (value: string) => void) {
      data.on('data', listener)
      return { dispose: () => data.off('data', listener) }
    },
    onExit(listener: (value: { exitCode: number; signal?: number }) => void) {
      exit.on('exit', listener)
      return { dispose: () => exit.off('exit', listener) }
    },
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    clear: vi.fn(),
    kill: vi.fn(),
    destroy: vi.fn()
  } satisfies pty.IPty & { destroy: () => void }
  return {
    process: process_,
    emitData: (value: string) => data.emit('data', value),
    emitExit: (exitCode: number, signal = 0) => exit.emit('exit', { exitCode, signal })
  }
}

function start(reportsChildExitStatus = true) {
  const native = nativePort()
  const env = { PATH: 'audit-path', ORDINARY_FIELD: 'small fixture' }
  const args = {
    process: native.process,
    shellPath: 'audit-shell',
    spawnCwd: process.cwd(),
    sessionId: 'native-env-retention',
    startupAgentRecognition: null,
    startupCommandDeliveredInShellArgs: true,
    reportsChildExitStatus,
    env
  }
  return {
    handle: createDaemonPtySubprocessHandle(args),
    native,
    refs: { args: new WeakRef(args), env: new WeakRef(env) }
  }
}

async function collect(): Promise<void> {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 6; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

describe('native PTY spawn environment lifetime', () => {
  it('releases completed spawn arguments while a live handle still forwards data and exit', async () => {
    const fixture = start()
    try {
      await collect()
      expect(fixture.refs.args.deref()).toBeUndefined()
      expect(fixture.refs.env.deref()).toBeUndefined()
      expect(fixture.handle.shellPathEnv).toBe('audit-path')
      expect(fixture.handle.startupCommandDeliveredInShellArgs).toBe(true)
      expect(fixture.handle.getForegroundProcess?.({ rawFallback: true })).toBe('audit-shell')

      fixture.native.emitData('early-output')
      const onData = vi.fn()
      const onExit = vi.fn()
      fixture.handle.onData(onData)
      fixture.handle.onExit(onExit)
      expect(onData).toHaveBeenCalledWith('early-output')
      fixture.handle.write('input')
      expect(fixture.native.process.write).toHaveBeenCalledWith('input')
      fixture.native.emitExit(7)
      expect(onExit).toHaveBeenCalledWith(7, { kind: 'exited', exitCode: 7 })
      fixture.handle.write('after-exit')
      fixture.handle.kill()
      fixture.handle.forceKill()
      expect(fixture.native.process.write).toHaveBeenCalledOnce()
    } finally {
      fixture.handle.dispose?.()
      fixture.handle.dispose?.()
      expect(fixture.native.process.destroy).toHaveBeenCalledOnce()
    }
  })

  it.each([true, false])('preserves the spawn-time exit-status fact: %s', async (reportsStatus) => {
    const fixture = start(reportsStatus)
    try {
      await collect()
      fixture.native.emitExit(0, 9)
      const onExit = vi.fn()
      fixture.handle.onExit(onExit)
      expect(onExit).toHaveBeenCalledWith(
        0,
        reportsStatus
          ? { kind: 'signaled', signal: 9 }
          : { kind: 'unknown', reason: 'host_status_unavailable' }
      )
    } finally {
      fixture.handle.dispose?.()
    }
  })
})
