import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { SessionShellReadyBarrier } from './session-shell-ready-barrier'

// `stty -a` of a zsh PTY on macOS, captured while a slow .zshrc runs and then at the zle prompt.
const STTY_WHILE_RC_FILES_RUN = `lflags: icanon isig iexten echo echoe -echok echoke -echonl echoctl
cchars: discard = ^O; dsusp = ^Y; eof = ^D; eol = <undef>;
	eol2 = <undef>; erase = ^?; intr = ^C; kill = ^U; lnext = ^V;`
const STTY_AT_LINE_EDITOR = `lflags: -icanon isig iexten -echo echoe -echok echoke -echonl echoctl
cchars: discard = <undef>; dsusp = <undef>; eof = ^D; eol = <undef>;
	eol2 = <undef>; erase = ^?; intr = ^C; kill = ^U;
	lnext = <undef>; min = 1; quit = <undef>; reprint = ^R;`
const SHELL_READY_MARKER = '\x1b]777;orca-shell-ready\x07'
const READY_DEADLINE_MS = 1_000

let stty = STTY_WHILE_RC_FILES_RUN
let written: string[] = []

beforeEach(() => {
  vi.useFakeTimers()
  stty = STTY_WHILE_RC_FILES_RUN
  written = []
  execFileMock.mockReset()
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: readonly string[],
      _options: { timeout: number; windowsHide: boolean },
      callback: (error: Error | null, stdout: string) => void
    ) => callback(null, stty)
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
  expect(barrier.tryEnqueue('echo SENTINEL\r')).toBe(true)
  return barrier
}

// #18172: a write that lands while rc files run is eaten by anything there that reads the terminal.
// ConPTY has no slave path to probe, so Windows still releases at the deadline.
it.skipIf(process.platform === 'win32')(
  'keeps the startup command held past the deadline until a slow shell reaches its prompt',
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

    stty = STTY_AT_LINE_EDITOR
    await vi.advanceTimersByTimeAsync(READY_DEADLINE_MS)
    expect(written).toEqual(['echo SENTINEL\r'])
  }
)
