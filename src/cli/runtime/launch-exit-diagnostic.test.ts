import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  macCrashReportGlob,
  openLaunchExitError,
  serveSignalExitError
} from './launch-exit-diagnostic'
import { superviseForegroundServe } from './serve-update-supervisor'
import { RuntimeClientError } from './types'

class FakeChildProcess extends EventEmitter {
  kill = vi.fn()
  pid = 5150
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function superviseUntilExit(code: number | null, signal: NodeJS.Signals | null): Promise<number> {
  const child = new FakeChildProcess()
  const supervised = superviseForegroundServe({
    executable: '/Applications/Orca.app/Contents/MacOS/Orca',
    childArgs: ['--serve'],
    spawnOptions: {},
    spawnChild: vi.fn() as never,
    handoffPath: null,
    child: child as never,
    expectedHandoff: null
  })
  child.emit('exit', code, signal)
  return supervised
}

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
})

describe('serveSignalExitError', () => {
  it('explains the macOS window-server abort on darwin SIGABRT', () => {
    const error = serveSignalExitError('SIGABRT', 'darwin')

    expect(error).toBeInstanceOf(RuntimeClientError)
    expect(error.code).toBe('runtime_serve_failed')
    expect(error.message).toContain('aborted with SIGABRT on macOS')
    // Why: naming the aborting frame is what makes the report searchable against
    // electron/electron#52815 instead of a generic "window server" guess.
    expect(error.message).toContain('_RegisterApplication')
    expect(error.message).toContain('before any Orca JavaScript ran')
    expect(error.message).toContain('Retrying cannot help')
    expect(error.data).toMatchObject({
      nextSteps: [
        expect.stringContaining('macOS desktop login'),
        expect.stringContaining('com.apple.lsd'),
        expect.stringContaining('_RegisterApplication')
      ]
    })
  })

  it('does not claim the macOS cause off darwin', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const error = serveSignalExitError('SIGABRT', platform)

      expect(error.message).toBe('Orca serve exited via SIGABRT.')
      expect(error.data).toBeUndefined()
    }
  })

  it('does not claim the macOS cause for other darwin signals', () => {
    const error = serveSignalExitError('SIGKILL', 'darwin')

    expect(error.message).toBe('Orca serve exited via SIGKILL.')
    expect(error.data).toBeUndefined()
  })

  it('stays clear when neither a code nor a signal is reported', () => {
    expect(serveSignalExitError(null, 'darwin').message).toBe(
      'Orca serve exited without reporting an exit code or signal.'
    )
  })
})

describe('superviseForegroundServe signal exits', () => {
  it('throws the macOS diagnostic when the child aborts on darwin', async () => {
    setPlatform('darwin')

    await expect(superviseUntilExit(null, 'SIGABRT')).rejects.toThrow(
      /aborted with SIGABRT on macOS/
    )
  })

  it('reports the plain signal on linux', async () => {
    setPlatform('linux')

    await expect(superviseUntilExit(null, 'SIGABRT')).rejects.toThrow(
      'Orca serve exited via SIGABRT.'
    )
  })

  it('returns numeric exit codes unchanged', async () => {
    setPlatform('darwin')

    await expect(superviseUntilExit(0, null)).resolves.toBe(0)
    await expect(superviseUntilExit(7, null)).resolves.toBe(7)
  })
})

describe('macCrashReportGlob', () => {
  it('names the report after the binary that actually aborts', () => {
    expect(macCrashReportGlob('/Applications/Orca.app/Contents/MacOS/Orca')).toBe(
      '~/Library/Logs/DiagnosticReports/Orca-*.ips'
    )
    // Why: a source/dev run execs Electron, so pointing at Orca-*.ips sends
    // people looking for a file macOS never wrote.
    expect(
      macCrashReportGlob('/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    ).toBe('~/Library/Logs/DiagnosticReports/Electron-*.ips')
  })
})

describe('openLaunchExitError', () => {
  it('explains the pre-JS abort instead of blaming a missing window', () => {
    const error = openLaunchExitError({ code: null, signal: 'SIGABRT' }, 'darwin')

    expect(error.code).toBe('runtime_open_failed')
    expect(error.message).toContain('_RegisterApplication')
    expect(error.message).toContain('Retrying cannot help')
  })

  it('reports a command that never started without the abort guidance', () => {
    // Why: nothing ran, so Launch Services and crash reports are the wrong
    // place to send the user — the executable path is what they must fix.
    const error = openLaunchExitError(
      { code: null, signal: null, spawnError: 'spawn /missing/Orca ENOENT' },
      'darwin'
    )

    expect(error.code).toBe('runtime_open_failed')
    expect(error.message).toBe('Could not start Orca: spawn /missing/Orca ENOENT')
    expect(error.message).not.toContain('_RegisterApplication')
  })

  it('reports a plain failed launch without claiming the macOS cause', () => {
    expect(openLaunchExitError({ code: 1, signal: null }, 'darwin').message).toBe(
      'Orca exited with exit code 1 while starting up, before a desktop window appeared.'
    )
    expect(openLaunchExitError({ code: null, signal: 'SIGABRT' }, 'linux').message).toBe(
      'Orca exited via SIGABRT while starting up, before a desktop window appeared.'
    )
  })
})
