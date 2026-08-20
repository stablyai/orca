// Regression guard: the Windows agent foreground-process scan re-forks wmic (or
// the powershell.exe fallback) on a ~1s/pane cadence. Electron's main process has
// no console, so a spawn without windowsHide pops a fresh conhost window per scan
// that flashes and steals keyboard focus from the foreground app (including
// Orca's own terminal). Both readers MUST pass windowsHide: true.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('child_process', () => ({ execFile: execFileMock }))

import {
  queryWindowsProcessDescendants,
  queryWindowsProcessRowsFresh,
  resetWindowsProcessRowsReaderForTests
} from './windows-foreground-process-rows'

type ExecFileCallback = (err: unknown, result: { stdout: string | Buffer; stderr: string }) => void
type ExecFileCall = [string, string[], Record<string, unknown>, ExecFileCallback]

const POWERSHELL_ROWS_JSON = JSON.stringify([
  {
    ProcessId: 100,
    ParentProcessId: 50,
    Name: 'powershell.exe',
    CommandLine: 'powershell.exe',
    ExecutablePath: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
  },
  {
    ProcessId: 200,
    ParentProcessId: 100,
    Name: 'node.exe',
    CommandLine: 'node C:/Users/dev/AppData/codex/bin/codex.js',
    ExecutablePath: 'C:/Program Files/nodejs/node.exe'
  }
])

const WMIC_ROWS_VALUE =
  'CommandLine=powershell.exe\n' +
  'ExecutablePath=C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe\n' +
  'Name=powershell.exe\n' +
  'ParentProcessId=50\n' +
  'ProcessId=100\n\n' +
  'CommandLine=node C:/Users/dev/AppData/codex/bin/codex.js\n' +
  'ExecutablePath=C:/Program Files/nodejs/node.exe\n' +
  'Name=node.exe\n' +
  'ParentProcessId=100\n' +
  'ProcessId=200\n'

/** wmic writes UTF-16LE through a redirected stdout, BOM included. */
const wmicUtf16 = (value: string): Buffer =>
  Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, 'utf16le')])

/** wmic is spawned by absolute path, so match on the basename. */
const basename = (command: string): string =>
  command
    .toLowerCase()
    .replace(/^.*[\\/]/, '')
    .replace(/\.exe$/, '')
const isCommand = (spawned: string, name: string): boolean => basename(spawned) === basename(name)

/** Returns the options object passed to the mocked execFile for a given command. */
function optionsForCommand(command: string): Record<string, unknown> | undefined {
  const call = execFileMock.mock.calls.find((args) =>
    isCommand((args as ExecFileCall)[0], command)
  ) as ExecFileCall | undefined
  return call?.[2]
}

describe('windows foreground process rows spawn options', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    execFileMock.mockReset()
    resetWindowsProcessRowsReaderForTests()
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('prefers wmic and spawns no PowerShell host when wmic exists (#15209)', async () => {
    execFileMock.mockImplementation((cmd: string, _args, _opts, cb: ExecFileCallback) => {
      if (isCommand(cmd, 'wmic')) {
        cb(null, { stdout: WMIC_ROWS_VALUE, stderr: '' })
        return
      }
      cb(new Error('powershell must not spawn when wmic answered'), { stdout: '', stderr: '' })
    })

    const candidates = await queryWindowsProcessDescendants(100)

    expect(candidates?.[0]?.pid).toBe(200)
    expect(optionsForCommand('wmic')).toMatchObject({ windowsHide: true })
    expect(
      execFileMock.mock.calls.some((args) => isCommand((args as ExecFileCall)[0], 'powershell'))
    ).toBe(false)
  })

  // Reading wmic's bytes as utf8 yields NUL-padded keys that match no property,
  // so the table parses to nothing and every machine silently stays on the
  // PowerShell path this fix exists to leave.
  it('reads the UTF-16LE table wmic writes through a redirected stdout', async () => {
    execFileMock.mockImplementation((cmd: string, _args, _opts, cb: ExecFileCallback) => {
      cb(
        isCommand(cmd, 'wmic')
          ? null
          : new Error('powershell must not answer a readable wmic table'),
        {
          stdout: wmicUtf16(WMIC_ROWS_VALUE),
          stderr: ''
        }
      )
    })

    const candidates = await queryWindowsProcessDescendants(100)

    expect(candidates?.[0]?.pid).toBe(200)
    expect(optionsForCommand('wmic')).toMatchObject({ encoding: 'buffer' })
  })

  // Orca's own agent panes run multi-line commands, so CR/LF inside CommandLine is
  // routine — `Key=Value` framing is exactly what it can impersonate, and a blank
  // line in there is exactly what a record separator looks like. Measured on a real
  // 920-process table: every command line carrying one belonged to a claude/codex/
  // node/sh pane, i.e. the rows foreground detection reads to name the agent.
  it('keeps an agent CommandLine holding CR/LF and a blank line in one row', async () => {
    const multiline =
      "CommandLine=claude --append-system-prompt $'line one\n" +
      '\n' +
      'ProcessId=4\n' +
      "line two'\n" +
      'ExecutablePath=C:/Users/dev/AppData/Local/claude/claude.exe\n' +
      'Name=claude.exe\n' +
      'ParentProcessId=100\n' +
      'ProcessId=300\n\n'
    execFileMock.mockImplementation((cmd: string, _args, _opts, cb: ExecFileCallback) => {
      cb(isCommand(cmd, 'wmic') ? null : new Error('powershell must not answer'), {
        stdout: `${WMIC_ROWS_VALUE}\n${multiline}`,
        stderr: ''
      })
    })

    const candidates = await queryWindowsProcessDescendants(100)

    expect(candidates?.map((row) => row.pid).sort()).toEqual([200, 300])
    expect(candidates?.find((row) => row.pid === 300)?.command).toBe(
      "claude --append-system-prompt $'line one\n\nProcessId=4\nline two'"
    )
  })

  // A command line can supply a whole record. The invented row is not inert: with
  // ppid set to Orca's own pid it bridges a real orphan (a process whose parent
  // already exited) into our subtree, and classifyWindowsTreeKillTarget then reads
  // that unrelated tree as `own` and lets `taskkill /T /F` have it. wmic closes
  // every record with an empty line, so properties resuming without one prove the
  // record came from content — and the whole snapshot is refused.
  it('refuses a table where a command line supplied a whole record (#15565 review)', async () => {
    const forged =
      'CommandLine=evil.exe\n' +
      'ExecutablePath=C:/fake.exe\n' +
      'Name=fake.exe\n' +
      'ParentProcessId=1000\n' +
      'ProcessId=5000\n' +
      'ExecutablePath=C:/real/evil.exe\n' +
      'Name=evil.exe\n' +
      'ParentProcessId=100\n' +
      'ProcessId=400\n\n'
    execFileMock.mockImplementation((cmd: string, _args, _opts, cb: ExecFileCallback) => {
      cb(null, {
        stdout: isCommand(cmd, 'wmic') ? `${WMIC_ROWS_VALUE}\n${forged}` : POWERSHELL_ROWS_JSON,
        stderr: ''
      })
    })

    const candidates = await queryWindowsProcessDescendants(100, { fresh: true })

    expect(candidates?.map((row) => row.pid)).toEqual([200])
    expect(candidates?.some((row) => row.pid === 5000)).toBe(false)
  })

  // A framing failure is content any local process can arrange. Retiring wmic over
  // it would hand that process a switch for turning the transcript flood back on.
  it('backs off after repeated framing failures, then retries wmic (#15565 review)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    try {
      let wmicSpawns = 0
      let hostile = true
      execFileMock.mockImplementation((cmd: string, _args, _opts, cb: ExecFileCallback) => {
        if (isCommand(cmd, 'wmic')) {
          wmicSpawns += 1
          // A command line that walks the framing: properties resume with no break.
          cb(null, {
            stdout: hostile
              ? 'CommandLine=x\nExecutablePath=a\nName=b\nParentProcessId=1\nProcessId=2\nExecutablePath=c\n'
              : WMIC_ROWS_VALUE,
            stderr: ''
          })
          return
        }
        cb(null, { stdout: POWERSHELL_ROWS_JSON, stderr: '' })
      })

      for (let scan = 0; scan < 3; scan += 1) {
        await queryWindowsProcessDescendants(100, { fresh: true })
      }
      expect(wmicSpawns).toBe(3)

      // Inside the backoff window wmic is not spawned at all — one process per
      // scan, never the two that a retry-every-scan policy would cost.
      await queryWindowsProcessDescendants(100, { fresh: true })
      expect(wmicSpawns).toBe(3)

      // ...and the fix comes back on its own once the window passes.
      hostile = false
      vi.setSystemTime(60_001)
      const candidates = await queryWindowsProcessDescendants(100, { fresh: true })

      expect(wmicSpawns).toBe(4)
      expect(candidates?.map((row) => row.pid)).toEqual([200])
    } finally {
      vi.useRealTimers()
    }
  })

  // A repeated pid means the record framing desynced, and ancestry read off a
  // desynced table can misdirect `taskkill /T /F`.
  it('discards a wmic table with duplicate pids and lets PowerShell answer', async () => {
    execFileMock.mockImplementation((cmd: string, _args, _opts, cb: ExecFileCallback) => {
      cb(null, {
        stdout: isCommand(cmd, 'wmic')
          ? `${WMIC_ROWS_VALUE}\n${WMIC_ROWS_VALUE}`
          : POWERSHELL_ROWS_JSON,
        stderr: ''
      })
    })

    const candidates = await queryWindowsProcessDescendants(100)

    expect(candidates?.map((row) => row.pid)).toEqual([200])
    expect(optionsForCommand('powershell.exe')).toMatchObject({ windowsHide: true })
  })

  it('stops spawning wmic once the host has none — 24H2+ (windowsHide stays on)', async () => {
    let wmicSpawns = 0
    execFileMock.mockImplementation((cmd: string, _args, _opts, cb: ExecFileCallback) => {
      if (isCommand(cmd, 'wmic')) {
        wmicSpawns += 1
        cb(Object.assign(new Error('spawn wmic ENOENT'), { code: 'ENOENT' }), {
          stdout: '',
          stderr: ''
        })
        return
      }
      cb(null, { stdout: POWERSHELL_ROWS_JSON, stderr: '' })
    })

    await queryWindowsProcessDescendants(100, { fresh: true })
    await queryWindowsProcessDescendants(100, { fresh: true })

    expect(wmicSpawns).toBe(1)
    expect(optionsForCommand('powershell.exe')).toMatchObject({ windowsHide: true })
  })

  // A WMI hiccup must not cost the fix for the rest of the process lifetime.
  it('retries wmic after a transient scan failure, and stops once they persist', async () => {
    let wmicSpawns = 0
    let failing = true
    execFileMock.mockImplementation((cmd: string, _args, _opts, cb: ExecFileCallback) => {
      if (isCommand(cmd, 'wmic')) {
        wmicSpawns += 1
        if (failing) {
          cb(new Error('wmi service hiccup'), { stdout: '', stderr: '' })
          return
        }
        cb(null, { stdout: WMIC_ROWS_VALUE, stderr: '' })
        return
      }
      cb(null, { stdout: POWERSHELL_ROWS_JSON, stderr: '' })
    })

    await queryWindowsProcessDescendants(100, { fresh: true })
    failing = false
    const candidates = await queryWindowsProcessDescendants(100, { fresh: true })

    expect(wmicSpawns).toBe(2)
    expect(candidates?.map((row) => row.pid)).toEqual([200])

    failing = true
    await queryWindowsProcessDescendants(100, { fresh: true })
    await queryWindowsProcessDescendants(100, { fresh: true })
    await queryWindowsProcessDescendants(100, { fresh: true })
    const spawnsAfterBackoff = wmicSpawns

    await queryWindowsProcessDescendants(100, { fresh: true })

    expect(wmicSpawns).toBe(spawnsAfterBackoff)
  })
})

// Regression guard: the PID-identity probe that gates `taskkill /T /F` needs rows
// from a scan started after it asked, but worktree delete tears down PTYs 32-wide.
// Reading the table uncached would fork 32 powershell cold-starts per delete.
describe('queryWindowsProcessRowsFresh', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    execFileMock.mockReset()
    resetWindowsProcessRowsReaderForTests()
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    // The capability probe answers for any wmic call; scans then use PowerShell.
    execFileMock.mockImplementation((cmd: string, _args, _opts, cb: ExecFileCallback) => {
      if (isCommand(cmd, 'wmic')) {
        cb(new Error('wmic not found'), { stdout: '', stderr: '' })
        return
      }
      cb(null, { stdout: POWERSHELL_ROWS_JSON, stderr: '' })
    })
  })

  afterEach(() => {
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  const powershellScanCount = (): number =>
    execFileMock.mock.calls.filter((call) => call[0] === 'powershell.exe').length

  // wmic's value format has no escaping and CommandLine is chosen by whoever
  // launched the process, so a command line can emit a whole well-formed record —
  // separator and resync line included — that no parser can tell from a real one.
  // An invented `{pid, ppid}` bridges a real orphan to our pid and hands an
  // unrelated tree to `taskkill /T /F`, so this reader must never touch wmic, even
  // where wmic is present and answering.
  it('never reads wmic, because its rows gate taskkill /T /F (#15565 review)', async () => {
    execFileMock.mockReset()
    execFileMock.mockImplementation((cmd: string, _args, _opts, cb: ExecFileCallback) => {
      cb(null, {
        stdout: isCommand(cmd, 'wmic') ? WMIC_ROWS_VALUE : POWERSHELL_ROWS_JSON,
        stderr: ''
      })
    })

    const rows = await queryWindowsProcessRowsFresh()

    expect(rows.map((row) => row.pid)).toEqual([100, 200])
    expect(
      execFileMock.mock.calls.some((args) => isCommand((args as ExecFileCall)[0], 'wmic'))
    ).toBe(false)
  })

  it('collapses a burst of concurrent identity probes into one scan', async () => {
    const rows = await Promise.all(Array.from({ length: 32 }, () => queryWindowsProcessRowsFresh()))

    expect(powershellScanCount()).toBe(1)
    expect(rows[31]?.map((row) => row.pid)).toEqual([100, 200])
  })

  it('never answers from the TTL cache, which can predate the recycle it detects', async () => {
    await queryWindowsProcessDescendants(100)
    expect(powershellScanCount()).toBe(1)

    await queryWindowsProcessRowsFresh()

    expect(powershellScanCount()).toBe(2)
  })
})
