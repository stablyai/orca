import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as pty from 'node-pty'
import {
  createDaemonPtySubprocessHandle,
  MASTER_CLOSE_EXIT_GRACE_MS
} from './pty-subprocess/subprocess-handle'
import { mockPtyProcess } from './pty-subprocess-test-harness'
import { TerminalHost } from './terminal-host'
import { HeadlessEmulator } from './headless-emulator'
import * as ptyJob from '../windows/windows-pty-job'

vi.mock('./pty-subprocess/foreground-process-tracker', () => ({
  createPtyForegroundProcessTracker: () => ({
    recordOutput: vi.fn(),
    markDead: vi.fn(),
    getForegroundProcess: () => null
  })
}))
vi.mock('../pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: async (_pid: number, fallback: () => void) => fallback()
}))
vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: async (_pid: number, killRoot: () => void) => killRoot()
}))

function createFixture() {
  const proc = {
    ...mockPtyProcess(4242),
    destroy: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    clear: vi.fn()
  }
  const handle = createDaemonPtySubprocessHandle({
    process: proc as unknown as pty.IPty,
    shellPath: 'bash',
    spawnCwd: process.cwd(),
    env: {},
    startupCommandDeliveredInShellArgs: false,
    reportsChildExitStatus: true,
    sessionId: 'io-failure',
    startupAgentRecognition: null
  })
  return { proc, handle }
}

function failIo(fixture: ReturnType<typeof createFixture>, operation: 'write' | 'resize') {
  fixture.proc[operation].mockImplementation(() => {
    throw new Error('transient native I/O failure')
  })
  if (operation === 'write') {
    fixture.handle.write('input')
  } else {
    fixture.handle.resize(100, 30)
  }
}

afterEach(() => vi.restoreAllMocks())

describe.each(['darwin', 'linux', 'win32'] as const)('%s native-handle contract', (platform) => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  beforeEach(() => Object.defineProperty(process, 'platform', { value: platform }))
  afterEach(() => Object.defineProperty(process, 'platform', platformDescriptor))

  describe.each(['write', 'resize'] as const)('%s failure cleanup', (operation) => {
    it('suppresses repeated native I/O failures while still delivering output and exit', () => {
      const fixture = createFixture()
      const onData = vi.fn()
      const onExit = vi.fn()
      fixture.handle.onData(onData)
      fixture.handle.onExit(onExit)
      failIo(fixture, operation)
      fixture.handle.pause?.()
      fixture.handle.resume?.()
      expect(fixture.proc.pause).toHaveBeenCalledOnce()
      expect(fixture.proc.resume).toHaveBeenCalledOnce()
      fixture.handle.write('more input')
      fixture.handle.resize(120, 40)
      fixture.handle.clear?.()
      expect(fixture.proc[operation]).toHaveBeenCalledOnce()
      for (const suppressed of ['write', 'resize', 'clear'] as const) {
        if (suppressed !== operation) {
          expect(fixture.proc[suppressed]).not.toHaveBeenCalled()
        }
      }
      fixture.proc._simulateData('still running')
      expect(onData).toHaveBeenCalledWith('still running')
      expect(onExit).not.toHaveBeenCalled()
      fixture.proc._simulateExit(7)
      expect(onExit).toHaveBeenCalledOnce()
      fixture.handle.dispose()
    })

    it('blocks reentrant termination from an exit listener after I/O failure', () => {
      const fixture = createFixture()
      const signal = vi.spyOn(process, 'kill').mockReturnValue(true)
      const nativeKill = fixture.proc.kill
      failIo(fixture, operation)
      fixture.handle.onExit(() => {
        fixture.handle.kill()
        fixture.handle.forceKill()
        fixture.handle.signal('SIGTERM')
      })
      fixture.proc._simulateExit(0)
      expect(nativeKill).not.toHaveBeenCalled()
      expect(signal).not.toHaveBeenCalled()
      fixture.handle.dispose()
    })

    it.skipIf(platform !== 'win32')(
      'preserves ConPTY single-close ownership after I/O failure',
      () => {
        const fixture = createFixture()
        const terminateJob = vi.spyOn(ptyJob, 'terminatePtyJob').mockReturnValue('terminated')
        const signal = vi.spyOn(process, 'kill').mockReturnValue(true)
        failIo(fixture, operation)
        fixture.handle.kill()
        fixture.handle.forceKill()
        fixture.proc._simulateExit(137)
        fixture.handle.dispose()
        expect(fixture.proc.kill).toHaveBeenCalledOnce()
        expect(terminateJob).toHaveBeenCalledOnce()
        expect(signal).not.toHaveBeenCalled()
        expect(fixture.proc.destroy).not.toHaveBeenCalled()
      }
    )

    it('preserves early output and exit status while fencing listener cleanup', () => {
      const fixture = createFixture()
      const signal = vi.spyOn(process, 'kill').mockReturnValue(true)
      failIo(fixture, operation)
      fixture.proc._simulateData('final output')
      fixture.proc._simulateExit(7)
      const delivered: string[] = []
      fixture.handle.onData((data) => {
        delivered.push(data)
        fixture.handle.forceKill()
      })
      fixture.handle.onExit((code) => delivered.push(`exit:${code}`))
      expect(delivered).toEqual(['final output', 'exit:7'])
      expect(signal).not.toHaveBeenCalled()
      fixture.handle.dispose()
    })

    it('keeps graceful and forced termination available until physical exit', () => {
      const fixture = createFixture()
      const originalKill = fixture.proc.kill
      const terminateJob = vi.spyOn(ptyJob, 'terminatePtyJob').mockReturnValue('unavailable')
      const signal = vi.spyOn(process, 'kill').mockReturnValue(true)
      failIo(fixture, operation)

      fixture.handle.kill()
      expect(originalKill).toHaveBeenCalledOnce()
      // A fresh handle exercises force-kill without Windows double-close semantics.
      const forced = createFixture()
      failIo(forced, operation)
      forced.handle.forceKill()
      if (platform === 'win32') {
        // An unverified PID can be reused; the per-PTY job/native handle owns this process tree.
        expect(signal).not.toHaveBeenCalled()
        expect(terminateJob).toHaveBeenCalledExactlyOnceWith(forced.proc)
        expect(forced.proc.kill).toHaveBeenCalledOnce()
      } else {
        expect(signal).toHaveBeenCalledWith(4242, 'SIGKILL')
      }

      forced.proc._simulateExit(137)
      signal.mockClear()
      forced.handle.forceKill()
      forced.handle.signal('SIGTERM')
      expect(signal).not.toHaveBeenCalled()
      fixture.proc._simulateExit(0)
      fixture.handle.dispose()
      forced.handle.dispose()
    })

    it('reaps every session and native handle across 32 failed-I/O create/close cycles', async () => {
      const emulatorDispose = vi.spyOn(HeadlessEmulator.prototype, 'dispose')
      const terminateJob = vi.spyOn(ptyJob, 'terminatePtyJob').mockReturnValue('unavailable')
      const signal = vi.spyOn(process, 'kill').mockReturnValue(true)
      let fixture = createFixture()
      const host = new TerminalHost({ spawnSubprocess: () => fixture.handle })
      try {
        for (let index = 0; index < 32; index++) {
          fixture = createFixture()
          const sessionId = `io-failure-${index}`
          const onExit = vi.fn()
          await host.createOrAttach({
            sessionId,
            cols: 80,
            rows: 24,
            streamClient: { onData: vi.fn(), onExit }
          })
          failIo(fixture, operation)
          signal.mockClear()
          const closing = host.kill(sessionId, { immediate: true })
          // Capture rejection before assertions so a red run cannot leak an unhandled waiter.
          const settled = closing.then(
            () => null,
            (error: unknown) => error ?? new Error('kill rejected')
          )
          let killFailure: unknown = null
          try {
            expect(host.listSessions()).toHaveLength(1)
            expect(fixture.proc.destroy).not.toHaveBeenCalled()
            expect(onExit).not.toHaveBeenCalled()
            if (platform === 'win32') {
              await vi.waitFor(() => expect(fixture.proc.kill).toHaveBeenCalledOnce(), {
                interval: 1
              })
              expect(terminateJob).toHaveBeenCalledWith(fixture.proc)
              // An unverified PID can be reused; the per-PTY job/native handle owns this process tree.
              expect(signal).not.toHaveBeenCalled()
            } else {
              await vi.waitFor(() => expect(signal).toHaveBeenCalledWith(4242, 'SIGKILL'), {
                interval: 1
              })
            }
          } finally {
            fixture.proc._simulateExit(137)
            killFailure = await settled
          }
          expect(killFailure).toBeNull()
          expect(host.listSessions()).toHaveLength(0)
          expect(onExit).toHaveBeenCalledOnce()
          if (platform === 'win32') {
            // An unverified PID can be reused; job/native close owns the tree and must not be repeated by destroy.
            expect(fixture.proc.destroy).not.toHaveBeenCalled()
            expect(fixture.proc.kill).toHaveBeenCalledOnce()
          } else {
            expect(fixture.proc.destroy).toHaveBeenCalledOnce()
          }
          expect(emulatorDispose).toHaveBeenCalledTimes(index + 1)
        }
      } finally {
        fixture.proc._simulateExit(137)
        await host.dispose()
      }
    })
  })

  it("treats a master-retiring stream error as closed input when node-pty emits no 'close'", () => {
    vi.useFakeTimers()
    try {
      const errorListeners: ((error: unknown) => void)[] = []
      const proc = {
        ...mockPtyProcess(4242),
        destroy: vi.fn(),
        _writable: true,
        on: (event: string, listener: (error: unknown) => void) => {
          if (event === 'error') {
            errorListeners.push(listener)
          }
        }
      }
      const handle = createDaemonPtySubprocessHandle({
        process: proc as unknown as pty.IPty,
        shellPath: 'pwsh.exe',
        spawnCwd: process.cwd(),
        env: {},
        startupCommandDeliveredInShellArgs: false,
        reportsChildExitStatus: true,
        sessionId: 'io-failure',
        startupAgentRecognition: null
      })
      const onInputClosed = vi.fn()
      handle.onInputClosed?.(onInputClosed)
      errorListeners.forEach((listener) => listener(new Error('read EAGAIN')))
      expect(handle.isInputClosed?.()).toBe(false)
      // node-pty's own handler runs first and retires the master before ours.
      proc._writable = false
      errorListeners.forEach((listener) => listener(new Error('read ECONNRESET')))
      expect(handle.isInputClosed?.()).toBe(true)
      handle.write('dropped')
      expect(proc.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(MASTER_CLOSE_EXIT_GRACE_MS)
      expect(onInputClosed).toHaveBeenCalledWith('master_closed: read ECONNRESET')
      handle.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
