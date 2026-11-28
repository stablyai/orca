import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: execFileMock }))
// Read the process table through ps on every platform so the canned output below is what the barrier sees.
vi.mock(
  '../../../shared/process-observation/darwin/libproc-process-table',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    readPsStdoutInProcess: async () => null
  })
)

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

// `stty -a` of a zsh PTY on macOS, captured while a slow .zshrc runs and then at the zle prompt.
const STTY_WHILE_RC_FILES_RUN = `lflags: icanon isig iexten echo echoe -echok echoke -echonl echoctl
cchars: discard = ^O; dsusp = ^Y; eof = ^D; eol = <undef>;
	eol2 = <undef>; erase = ^?; intr = ^C; kill = ^U; lnext = ^V;`
const STTY_AT_LINE_EDITOR = `lflags: -icanon isig iexten -echo echoe -echok echoke -echonl echoctl
cchars: discard = <undef>; dsusp = <undef>; eof = ^D; eol = <undef>;
	eol2 = <undef>; erase = ^?; intr = ^C; kill = ^U;
	lnext = <undef>; min = 1; quit = <undef>; reprint = ^R;`
// `ps -t <tty> -o ppid=,stat=` for the same PTY: the rc runs `sleep` in the foreground, then zsh owns it.
const PS_WHILE_RC_RUNS_A_COMMAND = '4241 Ss  \n4242 S+  \n'
const PS_AT_PROMPT = '4241 Ss+ \n'
const SHELL_IDENTITY_MARKER = '\x1b]777;orca-shell-start:4242\x07'
const SHELL_READY_MARKER = '\x1b]777;orca-shell-ready\x07'
const READY_DEADLINE_MS = 1_000

let stty = STTY_WHILE_RC_FILES_RUN
let ps = PS_WHILE_RC_RUNS_A_COMMAND
let written: string[] = []

describe('SessionShellReadyBarrier startup hold past the ready deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stty = STTY_WHILE_RC_FILES_RUN
    ps = PS_WHILE_RC_RUNS_A_COMMAND
    written = []
    execFileMock.mockReset()
    execFileMock.mockImplementation(
      (
        file: string,
        _args: readonly string[],
        _options: { timeout: number },
        callback: (error: Error | null, result: string | { stdout: string; stderr: string }) => void
      ) => callback(null, file === 'ps' ? { stdout: ps, stderr: '' } : stty)
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function zshBarrierWithStartupCommand(): SessionShellReadyBarrier {
    const barrier = new SessionShellReadyBarrier({
      sessionId: 'slow-rc-files',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the barrier reads only shellPath and slavePath and calls write.
      subprocess: {
        shellPath: '/bin/zsh',
        slavePath: '/dev/ttys042',
        write: (data: string) => written.push(data)
      } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the DA1 responder calls only registerCsiHandler.
      responderParser: { registerCsiHandler: () => ({ dispose: () => {} }) } as never,
      shellReadySupported: true,
      shellReadyTimeoutMs: READY_DEADLINE_MS,
      installDeviceAttributesFilter: () => {},
      releaseDeviceAttributesFilter: () => {},
      acceptStartupIngress: () => {}
    })
    barrier.ingestSubprocessData(SHELL_IDENTITY_MARKER)
    expect(barrier.tryEnqueue('echo SENTINEL\r')).toBe(true)
    return barrier
  }

  // #18172: a write that lands while rc files run a command is eaten by anything there that reads the terminal.
  // ConPTY has no slave path to probe, so Windows still releases at the deadline.
  it.skipIf(process.platform === 'win32')(
    'keeps the startup command held past the deadline while rc files run a command, until the prompt',
    async () => {
      const barrier = zshBarrierWithStartupCommand()

      await vi.advanceTimersByTimeAsync(READY_DEADLINE_MS * 10)
      expect(written).toEqual([])

      barrier.ingestSubprocessData(`READY% ${SHELL_READY_MARKER}`)
      expect(written).toEqual(['echo SENTINEL\r'])
    }
  )

  it.skipIf(process.platform === 'win32')(
    'releases the held command to a line editor that never prints the ready marker',
    async () => {
      zshBarrierWithStartupCommand()

      await vi.advanceTimersByTimeAsync(READY_DEADLINE_MS * 3)
      expect(written).toEqual([])

      ps = PS_AT_PROMPT
      stty = STTY_AT_LINE_EDITOR
      await vi.advanceTimersByTimeAsync(READY_DEADLINE_MS)
      expect(written).toEqual(['echo SENTINEL\r'])
    }
  )
})
