import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRODUCER_PAUSE_FAILSAFE_MS, Session } from './session'

function createRecordingSubprocess() {
  const written: string[] = []
  let onData: ((data: string) => void) | null = null
  let onExit: ((code: number) => void) | null = null
  let killed = false
  let clearCalls = 0
  let pauseCalls = 0
  let resumeCalls = 0

  return {
    pid: 12345,
    foregroundProcess: null as string | null,
    written,
    get killed() {
      return killed
    },
    get clearCalls() {
      return clearCalls
    },
    get pauseCalls() {
      return pauseCalls
    },
    get resumeCalls() {
      return resumeCalls
    },
    getForegroundProcess(): string | null {
      return this.foregroundProcess
    },
    write(data: string) {
      written.push(data)
    },
    resize(_cols: number, _rows: number) {},
    pause() {
      pauseCalls += 1
    },
    resume() {
      resumeCalls += 1
    },
    clear() {
      clearCalls += 1
    },
    kill() {
      killed = true
    },
    forceKill() {
      killed = true
    },
    signal(_signal: string) {},
    onData(callback: (data: string) => void) {
      onData = callback
    },
    onExit(callback: (code: number) => void) {
      onExit = callback
    },
    dispose() {},
    simulateData(data: string) {
      onData?.(data)
    },
    simulateExit(code: number) {
      onExit?.(code)
    }
  }
}

describe('Session terminal control', () => {
  let session: Session
  let subprocess: ReturnType<typeof createRecordingSubprocess>

  beforeEach(() => {
    vi.useFakeTimers()
    subprocess = createRecordingSubprocess()
  })

  afterEach(() => {
    session?.dispose()
    vi.useRealTimers()
  })

  function createSession(options: { shellReadySupported?: boolean } = {}): void {
    session = new Session({
      sessionId: 'test-session',
      cols: 80,
      rows: 24,
      subprocess,
      shellReadySupported: options.shellReadySupported ?? false
    })
  }

  function withPlatform(platform: NodeJS.Platform, run: () => void): void {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: platform })
    try {
      run()
    } finally {
      Object.defineProperty(process, 'platform', { value: original })
    }
  }

  describe('clearScrollback', () => {
    it('resyncs the native PTY screen state alongside the emulator clear', () => {
      createSession()
      session.clearScrollback()
      expect(subprocess.clearCalls).toBe(1)
      expect(session.takePendingOutput(false)?.records).toContainEqual({ kind: 'clear' })
    })

    it('nudges a Windows PowerShell prompt to repaint with a form feed', async () => {
      createSession()
      subprocess.foregroundProcess = 'powershell.exe'
      subprocess.simulateData('PS C:\\Users\\me> ')
      await vi.advanceTimersByTimeAsync(10)
      withPlatform('win32', () => session.clearScrollback())
      expect(subprocess.written).toEqual(['\x0c'])
    })

    it('does not send a form feed while input is pending at the prompt', async () => {
      createSession()
      subprocess.foregroundProcess = 'powershell.exe'
      subprocess.simulateData('PS C:\\Users\\me> fd')
      await vi.advanceTimersByTimeAsync(10)
      withPlatform('win32', () => session.clearScrollback())
      expect(subprocess.written).toEqual([])
    })

    it('does not send or queue a form feed before shell-ready', async () => {
      createSession({ shellReadySupported: true })
      subprocess.foregroundProcess = 'powershell.exe'
      subprocess.simulateData('PS C:\\Users\\me> ')
      await vi.advanceTimersByTimeAsync(10)
      withPlatform('win32', () => session.clearScrollback())
      expect(subprocess.written).toEqual([])
      subprocess.simulateData('\x1b]777;orca-shell-ready\x07\r\nPS C:\\Users\\me> ')
      await vi.advanceTimersByTimeAsync(10)
      expect(subprocess.written).toEqual([])
    })

    it('does not send a form feed at a PowerShell continuation prompt', async () => {
      createSession()
      subprocess.foregroundProcess = 'powershell.exe'
      subprocess.simulateData('PS C:\\Users\\me> {\r\n>> ')
      await vi.advanceTimersByTimeAsync(10)
      withPlatform('win32', () => session.clearScrollback())
      expect(subprocess.written).toEqual([])
    })

    it('does not send a form feed while a command owns the foreground', async () => {
      createSession()
      subprocess.foregroundProcess = 'node'
      subprocess.simulateData('PS C:\\Users\\me> ')
      await vi.advanceTimersByTimeAsync(10)
      withPlatform('win32', () => session.clearScrollback())
      expect(subprocess.written).toEqual([])
    })

    it('does not send a form feed on POSIX platforms', async () => {
      createSession()
      subprocess.foregroundProcess = 'pwsh'
      subprocess.simulateData('PS C:\\Users\\me> ')
      await vi.advanceTimersByTimeAsync(10)
      withPlatform('linux', () => session.clearScrollback())
      expect(subprocess.written).toEqual([])
    })

    it('does not touch the subprocess after dispose', () => {
      createSession()
      session.dispose()
      session.clearScrollback()
      expect(subprocess.clearCalls).toBe(0)
    })
  })

  describe('producer flow control', () => {
    it('auto-resumes when the owner loses the resume signal', () => {
      createSession()
      session.pauseProducer()
      expect(subprocess.pauseCalls).toBe(1)
      vi.advanceTimersByTime(PRODUCER_PAUSE_FAILSAFE_MS - 1)
      expect(subprocess.resumeCalls).toBe(0)
      vi.advanceTimersByTime(1)
      expect(subprocess.resumeCalls).toBe(1)
    })

    it('resumeProducer resumes once and cancels the failsafe', () => {
      createSession()
      session.pauseProducer()
      session.resumeProducer()
      expect(subprocess.resumeCalls).toBe(1)
      vi.advanceTimersByTime(PRODUCER_PAUSE_FAILSAFE_MS * 2)
      expect(subprocess.resumeCalls).toBe(1)
    })

    it('ignores resumeProducer without a matching pause', () => {
      createSession()
      session.resumeProducer()
      expect(subprocess.resumeCalls).toBe(0)
    })

    it('re-pausing re-arms the failsafe window', () => {
      createSession()
      session.pauseProducer()
      vi.advanceTimersByTime(PRODUCER_PAUSE_FAILSAFE_MS - 1_000)
      session.pauseProducer()
      vi.advanceTimersByTime(PRODUCER_PAUSE_FAILSAFE_MS - 1)
      expect(subprocess.resumeCalls).toBe(0)
      vi.advanceTimersByTime(1)
      expect(subprocess.resumeCalls).toBe(1)
    })

    it('resumes a paused producer before kill signals the child', () => {
      createSession()
      session.pauseProducer()
      session.kill()
      expect(subprocess.resumeCalls).toBe(1)
      expect(subprocess.killed).toBe(true)
    })

    it('dispose resumes a paused producer and clears the failsafe', () => {
      createSession()
      session.pauseProducer()
      session.dispose()
      expect(subprocess.resumeCalls).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('subprocess exit clears the failsafe without resuming a reaped child', () => {
      createSession()
      session.pauseProducer()
      subprocess.simulateExit(0)
      vi.advanceTimersByTime(PRODUCER_PAUSE_FAILSAFE_MS * 2)
      expect(subprocess.resumeCalls).toBe(0)
    })

    it('ignores pauseProducer on an exited session', () => {
      createSession()
      subprocess.simulateExit(0)
      session.pauseProducer()
      expect(subprocess.pauseCalls).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('detaching the last client resumes a paused producer', () => {
      createSession()
      const token = session.attachClient({ onData: () => {}, onExit: () => {} })
      session.pauseProducer()
      session.detachClient(token)
      expect(subprocess.resumeCalls).toBe(1)
    })

    it('keeps the pause while another client is attached', () => {
      createSession()
      const token = session.attachClient({ onData: () => {}, onExit: () => {} })
      session.attachClient({ onData: () => {}, onExit: () => {} })
      session.pauseProducer()
      session.detachClient(token)
      expect(subprocess.resumeCalls).toBe(0)
    })

    it('detachAllClients resumes a paused producer', () => {
      createSession()
      session.attachClient({ onData: () => {}, onExit: () => {} })
      session.pauseProducer()
      session.detachAllClients()
      expect(subprocess.resumeCalls).toBe(1)
    })
  })
})
