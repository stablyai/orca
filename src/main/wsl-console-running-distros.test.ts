import { describe, expect, it, vi } from 'vitest'
import {
  listRunningWslDistrosViaConsole,
  parseConsoleWslDistros,
  type WslConsole
} from './wsl-console-running-distros'

type FakeConsole = WslConsole & {
  emitData: (data: string) => void
  emitExit: (exitCode: number) => void
}

function fakeConsole(): FakeConsole {
  let onData: ((data: string) => void) | null = null
  let onExit: ((event: { exitCode: number }) => void) | null = null
  return {
    onData: (listener) => {
      onData = listener
      return { dispose: () => (onData = null) }
    },
    onExit: (listener) => {
      onExit = listener
      return { dispose: () => (onExit = null) }
    },
    kill: vi.fn(),
    emitData: (data) => onData?.(data),
    emitExit: (exitCode) => onExit?.({ exitCode })
  }
}

// What ConPTY paints around `wsl.exe --list --running` with Ubuntu-24.04 (the default) running (#35509).
const CONPTY_OUTPUT =
  '\u001b[?9001h\u001b[?1004h\u001b[?25l\u001b[2J\u001b[m\u001b[H' +
  '\u001b]0;C:\\WINDOWS\\System32\\wsl.exe\u0007\u001b[?25h' +
  'Windows Subsystem for Linux Distributions:\r\nUbuntu-24.04 (Default)\r\n' +
  '\u001b[?9001l\u001b[?1004l'
// Its answer when nothing runs; wsl.exe then exits -1, which the console reports unsigned.
const NONE_RUNNING_OUTPUT =
  '\u001b[?25l\u001b[2J\u001b[m\u001b[HThere are no running distributions.\r\n\u001b[?25h'
const NONE_RUNNING_EXIT = 4_294_967_295

function ask(registered: readonly string[] = ['Ubuntu-24.04']): {
  console: FakeConsole
  spawn: ReturnType<typeof vi.fn<(args: string[]) => WslConsole>>
  result: Promise<string[]>
} {
  const console = fakeConsole()
  const spawn = vi.fn<(args: string[]) => WslConsole>(() => console)
  return { console, spawn, result: listRunningWslDistrosViaConsole(registered, 5000, spawn) }
}

describe('running WSL distros read through a console', () => {
  it('finds registered names past the header and the default marker', () => {
    expect(parseConsoleWslDistros(CONPTY_OUTPUT, ['Ubuntu-24.04', 'Debian'])).toEqual([
      'Ubuntu-24.04'
    ])
  })

  it('splits rows the console placed by cursor moves, in registered spelling', () => {
    const output = '\u001b[1;1Hubuntu-24.04 (Default)\u001b[K\u001b[2;1HDebian\u001b[K'
    expect(parseConsoleWslDistros(output, ['Ubuntu-24.04', 'Debian'])).toEqual([
      'Ubuntu-24.04',
      'Debian'
    ])
  })

  it.each([
    ['ko-KR, no space', 'Ubuntu-24.04(기본값)'],
    ['nb-NO, no-break space', 'Ubuntu-24.04\u00a0(standard)'],
    ['full-width parens', 'Ubuntu-24.04（默认）']
  ])('reads the default row with a localized suffix (%s)', (_locale, row) => {
    const output = `Header:\r\n${row}\r\nDebian\r\n`
    expect(parseConsoleWslDistros(output, ['Ubuntu-24.04', 'Debian'])).toEqual([
      'Ubuntu-24.04',
      'Debian'
    ])
  })

  it('asks only for the running list, which never starts a distro', async () => {
    const { console, spawn, result } = ask()
    console.emitData(CONPTY_OUTPUT)
    console.emitExit(0)

    await expect(result).resolves.toEqual(['Ubuntu-24.04'])
    expect(spawn).toHaveBeenCalledWith(['--list', '--running'])
  })

  it('stays unverifiable on the localized none-running answer', async () => {
    const { console, result } = ask()
    console.emitData(NONE_RUNNING_OUTPUT)
    console.emitExit(NONE_RUNNING_EXIT)

    await expect(result).rejects.toThrow('not recognisable')
  })

  it('stays unverifiable when wsl.exe exits 0 with nothing painted', async () => {
    const { console, result } = ask()
    console.emitData('\u001b[?25l\u001b[2J\u001b[H\u001b[?25h')
    console.emitExit(0)

    await expect(result).rejects.toThrow('not recognisable')
  })

  it('stays unverifiable on a failure', async () => {
    const { console, result } = ask()
    console.emitData('Error code: Wsl/Service/E_UNEXPECTED\r\n')
    console.emitExit(NONE_RUNNING_EXIT)

    await expect(result).rejects.toThrow('not recognisable')
  })

  it('stays unverifiable when exit 0 lists no registered distro', async () => {
    const { console, result } = ask()
    console.emitData('Windows Subsystem for Linux Distributions:\r\nOther\r\n')
    console.emitExit(0)

    await expect(result).rejects.toThrow('not recognisable')
  })

  it('kills a console that does not answer in time', async () => {
    vi.useFakeTimers()
    try {
      const { console, result } = ask()
      const rejected = expect(result).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(5000)
      await rejected
      expect(console.kill).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
