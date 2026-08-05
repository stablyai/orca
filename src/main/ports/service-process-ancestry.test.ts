import { describe, expect, it, vi } from 'vitest'
import {
  buildProcessAncestryTable,
  commandLookupKey,
  condenseLaunchCommand,
  executableName,
  parseProcessAncestryOutput,
  parseWindowsAncestryJson,
  readProcessAncestryTable,
  resolveServiceLaunchOrigin
} from './service-process-ancestry'

// Captured verbatim from `ps -axo pid=,ppid=,command=` for a Next dev server an
// agent started: next-server -> next dev -> pnpm -> pnpm dev -> zsh -> claude -> Orca.
const REAL_PS_OUTPUT = [
  ' 3152  3102 next-server (v16.2.9)',
  ' 3102  3060 node /Users/me/Work/numis/mono-numis-store/apps/numis-funding/node_modules/.bin/../next/dist/bin/next dev -p 3940',
  ' 3060  3037 node /Users/me/.nvm/versions/node/v22.20.0/bin/pnpm -r --parallel dev',
  ' 3037  3034 node /Users/me/.nvm/versions/node/v22.20.0/bin/pnpm dev',
  ' 3034 98562 /bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-1785.sh',
  '98562 98515 claude --teammate-mode auto --dangerously-skip-permissions',
  '98515 98503 /Applications/Orca.app/Contents/MacOS/Orca',
  '    1     0 /sbin/launchd'
].join('\n')

const realTable = buildProcessAncestryTable(parseProcessAncestryOutput(REAL_PS_OUTPUT))

describe('parseProcessAncestryOutput', () => {
  it('parses pid, ppid and a command containing spaces', () => {
    const rows = parseProcessAncestryOutput(REAL_PS_OUTPUT)

    expect(rows).toHaveLength(8)
    expect(rows[0]).toEqual({ pid: 3152, ppid: 3102, command: 'next-server (v16.2.9)' })
  })

  it('ignores header noise and malformed lines', () => {
    expect(parseProcessAncestryOutput('  PID  PPID COMMAND\n\ngarbage\n')).toEqual([])
  })
})

describe('executableName', () => {
  it('takes the basename of a POSIX path', () => {
    expect(executableName('/bin/zsh -c source x.sh')).toBe('zsh')
  })

  it('takes the basename of a Windows path', () => {
    expect(executableName('C:\\Windows\\System32\\cmd.exe /c dev')).toBe('cmd.exe')
  })

  it('handles a bare command', () => {
    expect(executableName('claude --teammate-mode auto')).toBe('claude')
  })
})

describe('commandLookupKey', () => {
  it('strips the Windows executable suffix so one key covers both platforms', () => {
    // Windows reports claude.exe where POSIX reports claude. Keying on the raw
    // basename made every agent lookup miss on Windows.
    expect(commandLookupKey('C:\\Users\\me\\claude.exe --teammate-mode auto')).toBe('claude')
    expect(commandLookupKey('claude --teammate-mode auto')).toBe('claude')
  })

  it('covers the other suffixes Windows appends', () => {
    expect(commandLookupKey('pnpm.cmd dev')).toBe('pnpm')
    expect(commandLookupKey('thing.bat')).toBe('thing')
  })

  it('leaves a name with an unrelated dot alone', () => {
    expect(commandLookupKey('python3.11 -m http.server')).toBe('python3.11')
  })
})

describe('condenseLaunchCommand', () => {
  it('drops the node interpreter and the script path', () => {
    expect(condenseLaunchCommand('node /Users/me/.nvm/versions/node/v22.20.0/bin/pnpm dev')).toBe(
      'pnpm dev'
    )
  })

  it('keeps flags intact', () => {
    expect(condenseLaunchCommand('node /a/very/long/path/to/bin/pnpm -r --parallel dev')).toBe(
      'pnpm -r --parallel dev'
    )
  })

  it('leaves a non-interpreter command alone', () => {
    expect(condenseLaunchCommand('docker compose up -d')).toBe('docker compose up -d')
  })

  it('keeps short relative arguments verbatim', () => {
    expect(condenseLaunchCommand('npm run dev')).toBe('npm run dev')
  })

  it('preserves the case of a collapsed path, since this string is displayed', () => {
    expect(
      condenseLaunchCommand(
        '/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter'
      )
    ).toBe('ControlCenter')
  })
})

describe('resolveServiceLaunchOrigin', () => {
  it('reports the meaningful command, not the listening process', () => {
    const origin = resolveServiceLaunchOrigin(3152, realTable)

    // The listener is `next-server`; what the user recognizes is `pnpm dev`.
    expect(origin.launchCommand).toBe('pnpm dev')
  })

  it('names the coding agent that started the service', () => {
    expect(resolveServiceLaunchOrigin(3152, realTable).launchedByAgent).toBe('Claude Code')
  })

  it('stops at the shell rather than reporting Orca as the launcher', () => {
    expect(resolveServiceLaunchOrigin(3152, realTable).launchCommand).not.toContain('Orca')
  })

  it('returns nulls for an unknown pid instead of inventing a chain', () => {
    expect(resolveServiceLaunchOrigin(4242, realTable)).toEqual({
      launchCommand: null,
      launchedByAgent: null,
      ancestorPids: []
    })
  })

  it('reports no agent when a human started the service from a plain shell', () => {
    const table = buildProcessAncestryTable(
      parseProcessAncestryOutput(
        [
          ' 500 400 node /repo/node_modules/.bin/vite',
          ' 400 300 /bin/zsh',
          ' 300   1 /Applications/iTerm.app/Contents/MacOS/iTerm2'
        ].join('\n')
      )
    )

    const origin = resolveServiceLaunchOrigin(500, table)

    expect(origin.launchCommand).toBe('vite')
    expect(origin.launchedByAgent).toBeNull()
  })

  it('falls back to the process itself when it has no parent in the table', () => {
    const table = buildProcessAncestryTable([
      { pid: 10, ppid: 9, command: 'python -m http.server' }
    ])

    expect(resolveServiceLaunchOrigin(10, table).launchCommand).toBe('python -m http.server')
  })

  it('terminates on a self-referencing parent', () => {
    const table = buildProcessAncestryTable([{ pid: 7, ppid: 7, command: 'weird' }])

    expect(resolveServiceLaunchOrigin(7, table).launchCommand).toBe('weird')
  })

  it('terminates on a cycle rather than spinning', () => {
    const table = buildProcessAncestryTable([
      { pid: 1001, ppid: 1002, command: 'a' },
      { pid: 1002, ppid: 1001, command: 'b' }
    ])

    expect(resolveServiceLaunchOrigin(1001, table).launchCommand).toBe('b')
  })

  it('stops at an agent parent instead of reporting its prompt as the command', () => {
    // An agent can spawn a service with no shell in between. Its command line
    // carries the whole prompt, so climbing into it dumps thousands of chars.
    const prompt = 'You are taking over a feature. '.repeat(80)
    const table = buildProcessAncestryTable([
      { pid: 60, ppid: 59, command: 'python3 -m http.server 47311' },
      { pid: 59, ppid: 58, command: `claude --dangerously-skip-permissions ${prompt}` }
    ])

    const origin = resolveServiceLaunchOrigin(60, table)

    expect(origin.launchCommand).toBe('python3 -m http.server 47311')
    expect(origin.launchedByAgent).toBe('Claude Code')
  })

  it('never returns an unbounded command', () => {
    const table = buildProcessAncestryTable([
      { pid: 70, ppid: 69, command: `node /repo/bin/server ${'--flag=value '.repeat(200)}` },
      { pid: 69, ppid: 68, command: '/bin/zsh' }
    ])

    const { launchCommand } = resolveServiceLaunchOrigin(70, table)

    expect(launchCommand!.length).toBeLessThanOrEqual(120)
    expect(launchCommand).toMatch(/…$/)
  })

  it('recognizes an agent launched as a Windows executable', () => {
    const table = buildProcessAncestryTable([
      { pid: 30, ppid: 29, command: 'node C:\\repo\\node_modules\\.bin\\vite' },
      { pid: 29, ppid: 28, command: 'C:\\Windows\\System32\\cmd.exe /c dev' },
      { pid: 28, ppid: 1, command: 'C:\\Users\\me\\AppData\\claude.exe --teammate-mode auto' }
    ])

    const origin = resolveServiceLaunchOrigin(30, table)

    expect(origin.launchedByAgent).toBe('Claude Code')
    expect(origin.launchCommand).toBe('vite')
  })

  it('recognizes codex as the launching agent', () => {
    const table = buildProcessAncestryTable(
      parseProcessAncestryOutput(
        [' 20 19 node /repo/bin/vite', ' 19 18 /bin/bash -c x', ' 18 17 codex exec'].join('\n')
      )
    )

    expect(resolveServiceLaunchOrigin(20, table).launchedByAgent).toBe('Codex')
  })

  it('reports no agent for an unrecognized parent rather than guessing', () => {
    const table = buildProcessAncestryTable(
      parseProcessAncestryOutput(
        [' 20 19 node /repo/bin/vite', ' 19 18 /bin/bash -c x', ' 18 17 some-unknown-tool'].join(
          '\n'
        )
      )
    )

    expect(resolveServiceLaunchOrigin(20, table).launchedByAgent).toBeNull()
  })
})

describe('parseWindowsAncestryJson', () => {
  it('reads a JSON array of processes', () => {
    const rows = parseWindowsAncestryJson(
      JSON.stringify([
        { ProcessId: 10, ParentProcessId: 4, CommandLine: 'node server.js', Name: 'node.exe' },
        { ProcessId: 4, ParentProcessId: 1, CommandLine: null, Name: 'cmd.exe' }
      ])
    )

    expect(rows).toEqual([
      { pid: 10, ppid: 4, command: 'node server.js' },
      { pid: 4, ppid: 1, command: 'cmd.exe' }
    ])
  })

  it('accepts the single-object shape ConvertTo-Json emits for one row', () => {
    const rows = parseWindowsAncestryJson(
      JSON.stringify({ ProcessId: 10, ParentProcessId: 4, CommandLine: 'node a.js' })
    )

    expect(rows).toHaveLength(1)
  })

  it('returns nothing for unparsable output', () => {
    expect(parseWindowsAncestryJson('not json')).toEqual([])
  })
})

describe('readProcessAncestryTable', () => {
  it('leaves the command budget to the scan worker', async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: REAL_PS_OUTPUT })

    const table = await readProcessAncestryTable(runCommand)

    // A timeout argument here would be silently ignored by the worker client,
    // so passing one would misreport the real bound to every reader.
    expect(runCommand.mock.calls[0]).toHaveLength(2)
    expect(table.size).toBe(8)
  })

  it('degrades to an empty table when ps is unavailable', async () => {
    const runCommand = vi.fn().mockRejectedValue(new Error('spawn ps ENOENT'))

    await expect(readProcessAncestryTable(runCommand)).resolves.toEqual(new Map())
  })
})
