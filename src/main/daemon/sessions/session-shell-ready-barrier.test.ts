import { describe, expect, it, vi } from 'vitest'
import { SessionShellReadyBarrier } from './session-shell-ready-barrier'
import type { SubprocessHandle } from './session-subprocess-handle'
import { HeadlessEmulator } from '../emulation/headless-emulator'

function createBarrier(shellReadyTimeoutMs = 50) {
  const writes: string[] = []
  const emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
  const subprocess: SubprocessHandle = {
    pid: 1234,
    shellPath: '/bin/zsh',
    getForegroundProcess: () => null,
    write: (data: string) => {
      writes.push(data)
    },
    resize: () => {},
    kill: () => {},
    forceKill: () => {},
    terminateOwnedTree: () => 'unavailable',
    signal: () => {},
    onData: () => {},
    onExit: () => {},
    dispose: () => {}
  }

  const barrier = new SessionShellReadyBarrier({
    sessionId: 'sess-1',
    subprocess,
    responderParser: emulator.responderParser,
    shellReadySupported: true,
    shellReadyTimeoutMs,
    installDeviceAttributesFilter: () => {},
    releaseDeviceAttributesFilter: () => {},
    acceptStartupIngress: () => {}
  })

  return {
    barrier,
    writes,
    dispose: () => {
      barrier.dispose()
      emulator.dispose()
    }
  }
}

describe('SessionShellReadyBarrier typeahead clear invariants', () => {
  it('never sends Ctrl-U on shell-ready timeout when an rc-file reader may own stdin', () => {
    vi.useFakeTimers()
    const { barrier, writes, dispose } = createBarrier(50)
    try {
      expect(barrier.tryEnqueue('claude\n')).toBe(true)
      barrier.observeTypedInput('passphrase')
      vi.advanceTimersByTime(50)
      expect(barrier.state).toBe('timed_out')
      expect(writes).toEqual(['claude\n'])
    } finally {
      dispose()
      vi.useRealTimers()
    }
  })

  it('clears unsubmitted typeahead on ready, but not after a submitted line (e.g. answered rc question)', () => {
    vi.useFakeTimers()
    const readyMarker = '\x1b]777;orca-shell-ready\x07'

    // Answered rc-file prompt ("y" + Enter): no Ctrl-U when shell reaches ready.
    const answered = createBarrier(5_000)
    try {
      expect(answered.barrier.tryEnqueue('claude\n')).toBe(true)
      answered.barrier.observeTypedInput('y')
      answered.barrier.observeTypedInput('\r')
      answered.barrier.ingestSubprocessData(readyMarker)
      vi.advanceTimersByTime(250)
      expect(answered.barrier.state).toBe('ready')
      expect(answered.writes).toEqual(['claude\n'])
    } finally {
      answered.dispose()
    }

    // Unsubmitted typeahead ("hello"): kills typed line before injecting startup command.
    const unsubmitted = createBarrier(5_000)
    try {
      expect(unsubmitted.barrier.tryEnqueue('claude\n')).toBe(true)
      unsubmitted.barrier.observeTypedInput('y\rhello')
      unsubmitted.barrier.ingestSubprocessData(readyMarker)
      vi.advanceTimersByTime(250)
      expect(unsubmitted.barrier.state).toBe('ready')
      expect(unsubmitted.writes).toEqual([' \x15', 'claude\n'])
    } finally {
      unsubmitted.dispose()
      vi.useRealTimers()
    }
  })
})
