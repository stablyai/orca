import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  WSL_BRIDGE_INVOCATION_FLAG,
  buildWslBridgeScript,
  buildWslLauncher
} from './wsl-cli-scripts'

const WINDOWS_LAUNCHER = 'C:\\Program Files\\Orca\\resources\\bin\\orca.exe'
const BRIDGE_PATH = '/home/alice/.local/share/orca/orca-wsl-bridge.ps1'

// The reported failure: `--for` is a prefix of the bridge's former -ForwardArgs
// parameter, so PowerShell bound it as a parameter name and the leading
// subcommands lost their positional slot.
const REGRESSION_ARGV = [
  'terminal',
  'wait',
  '--terminal',
  'HANDLE',
  '--for',
  'tui-idle',
  '--timeout-ms',
  '1000'
]

// Flags that collided with the bridge's own parameters or with the common
// parameters CmdletBinding used to add. These were dropped without any error.
const COLLIDING_ARGV = [
  '--for',
  'a',
  '--forwardargs',
  'b',
  '--orcalauncher',
  'c',
  '--wslcwd',
  'd',
  '--verbose',
  '--debug',
  '--erroraction',
  'Stop',
  '--ov',
  'e'
]

const HOSTILE_ARGV = [
  'say "hi"',
  "it's",
  'sp ace',
  '',
  '-',
  '--',
  '--%',
  'amp&and',
  'pct%var%',
  'caret^x',
  'dollar$x',
  'back`tick',
  'semi;colon',
  'ünïcødé 한글',
  'trailing\\',
  'new\nline',
  'tab\there'
]

function splitTerminatedRecords(payload: string): string[] {
  // Every record is NUL-terminated, so the split always leaves a trailing slot.
  return payload.split('\0').slice(0, -1)
}

type LauncherRun = {
  powershellArgv: string[]
  target: string
  cwd: string
  expectedCwd: string
  forwarded: string[]
}

/**
 * Runs the generated launcher under real bash with stubbed Windows interop and
 * returns the payload it hands PowerShell.
 *
 * Scope: this stops at the launcher. It does not execute the bridge, and it says
 * nothing about `& $OrcaLauncher @ForwardArgs`, where PowerShell 5.1 still drops
 * ASCII quotes and empty strings when building native argv (#12231).
 */
async function runGeneratedLauncher(argv: string[]): Promise<LauncherRun> {
  const root = await mkdtemp(join(tmpdir(), 'orca-wsl-bridge-argv-'))
  try {
    const binDir = join(root, 'bin')
    const workDir = join(root, 'work')
    await mkdir(binDir, { recursive: true })
    await mkdir(workDir, { recursive: true })

    const argvFile = join(root, 'powershell-argv')
    await writeFile(join(binDir, 'wslpath'), '#!/usr/bin/env bash\nprintf "WIN:%s" "$2"\n', 'utf8')
    await writeFile(
      join(binDir, 'powershell.exe'),
      `#!/usr/bin/env bash\nfor a in "$@"; do printf '%s\\0' "$a"; done > ${JSON.stringify(argvFile)}\n`,
      'utf8'
    )
    await chmod(join(binDir, 'wslpath'), 0o755)
    await chmod(join(binDir, 'powershell.exe'), 0o755)

    const launcherPath = join(root, 'orca-ide')
    await writeFile(launcherPath, buildWslLauncher(WINDOWS_LAUNCHER, BRIDGE_PATH), 'utf8')

    execFileSync('bash', [launcherPath, ...argv], {
      cwd: workDir,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` }
    })

    const powershellArgv = splitTerminatedRecords(await readFile(argvFile, 'utf8'))
    const encoded = powershellArgv.at(-1) ?? ''
    const records = splitTerminatedRecords(Buffer.from(encoded, 'base64').toString('utf8'))
    return {
      powershellArgv,
      target: records[0] ?? '',
      cwd: records[1] ?? '',
      expectedCwd: `WIN:${await realpath(workDir)}`,
      forwarded: records.slice(2)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('WSL CLI bridge argument forwarding', () => {
  it('keeps forwarded arguments away from the PowerShell parameter binder', () => {
    const bridge = buildWslBridgeScript()

    // Why: the bug was a param() block. Any declared parameter makes PowerShell
    // prefix-match forwarded flags against it, so re-adding one silently breaks
    // every multi-flag command again.
    expect(bridge).not.toMatch(/^\s*param\s*\(/mu)
    expect(bridge).not.toContain('CmdletBinding')
    expect(bridge).not.toContain('ValueFromRemainingArguments')
    expect(bridge).toContain(`$args[0] -eq '${WSL_BRIDGE_INVOCATION_FLAG}'`)
  })

  it('guards the payload decode', () => {
    // Why: no test executes PowerShell, so pin the two decode invariants by
    // shape — a short payload must be rejected rather than indexed into, and the
    // trailing slot from the launcher's final NUL must be dropped.
    const bridge = buildWslBridgeScript()

    expect(bridge).toContain('$records.Count -lt 3')
    expect(bridge).toContain('$records[0..($records.Count - 2)]')
  })

  it('still reads the previous launcher calling convention', () => {
    // Why: the installer publishes the bridge before the launcher, so an
    // interrupted upgrade leaves this bridge paired with the old launcher.
    const bridge = buildWslBridgeScript()

    expect(bridge).toContain("$ForwardArgs[0] -eq '-WslCwd'")
    expect(bridge).toContain('$OrcaLauncher = $args[0]')
  })

  it.skipIf(process.platform === 'win32')(
    'forwards the reported multi-flag command unchanged',
    async () => {
      const run = await runGeneratedLauncher(REGRESSION_ARGV)

      expect(run.forwarded).toEqual(REGRESSION_ARGV)
      expect(run.target).toBe(WINDOWS_LAUNCHER)
      expect(run.powershellArgv.slice(0, 4)).toEqual([
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File'
      ])
      expect(run.powershellArgv[4]).toBe(`WIN:${BRIDGE_PATH}`)
      expect(run.powershellArgv[5]).toBe(WSL_BRIDGE_INVOCATION_FLAG)
      // Why: exactly one opaque record reaches PowerShell, so no CLI token can
      // ever be read as a parameter name.
      expect(run.powershellArgv).toHaveLength(7)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'forwards flags that collide with the bridge and CmdletBinding parameter names',
    async () => {
      const run = await runGeneratedLauncher(COLLIDING_ARGV)

      expect(run.forwarded).toEqual(COLLIDING_ARGV)
    }
  )

  // Why: encoding only. These same arguments are still corrupted later at
  // `& $OrcaLauncher @ForwardArgs` (#12231), so a pass here must not be read as
  // proof that quotes and empty strings reach the CLI.
  it.skipIf(process.platform === 'win32')(
    'encodes quoting, empty, and non-ASCII arguments into the payload without loss',
    async () => {
      const run = await runGeneratedLauncher(HOSTILE_ARGV)

      expect(run.forwarded).toEqual(HOSTILE_ARGV)
    }
  )

  it.skipIf(process.platform === 'win32')('forwards an empty argument list', async () => {
    const run = await runGeneratedLauncher([])

    expect(run.forwarded).toEqual([])
    expect(run.target).toBe(WINDOWS_LAUNCHER)
  })

  it.skipIf(process.platform === 'win32')('carries the resolved WSL cwd', async () => {
    const run = await runGeneratedLauncher(['terminal', 'list', '--json'])

    expect(run.cwd).toBe(run.expectedCwd)
    expect(run.forwarded).toEqual(['terminal', 'list', '--json'])
  })
})
