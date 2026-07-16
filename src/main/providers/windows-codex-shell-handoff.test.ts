import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildWindowsCodexShellHandoffAttempt,
  decodeWindowsCodexShellHandoffConfig,
  encodeWindowsCodexShellHandoffConfig,
  WINDOWS_CODEX_SHELL_HANDOFF_HOST_SCRIPT,
  type WindowsCodexShellHandoffConfig
} from './windows-codex-shell-handoff'
import { isCanonicalCodexPackageShim } from './windows-powershell-command-resolution'
import { resolveWindowsShellLaunchArgs } from './windows-shell-args'

const POWER_SHELL = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const CWD = 'C:\\repo'
const DEFAULT_CWD = 'C:\\Users\\dev'
const DEFAULT_PATH_EXT = '.COM;.EXE;.BAT;.CMD'
const TRUSTED_CODEX_ENTRYPOINT = readFileSync(
  new URL('./__fixtures__/codex-cli-entrypoint-0.144.5.txt', import.meta.url),
  'utf8'
).replace(/\r\n?/g, '\n')

const CANONICAL_NPM_CMD_SHIM = String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
`

const CANONICAL_NPM_POWERSHELL_SHIM = String.raw`#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  # Fix case when both the Windows and Linux builds of Node
  # are installed in the same directory
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "$basedir/node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args
  } else {
    & "$basedir/node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args
  }
  $ret=$LASTEXITCODE
} else {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args
  } else {
    & "node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args
  }
  $ret=$LASTEXITCODE
}
exit $ret
`

const tempRoots: string[] = []

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-windows-codex-handoff-'))
  tempRoots.push(root)
  return root
}

function makeFile(path: string, contents = ''): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  return path
}

function makeBasePaths(root: string): {
  nodePath: string
  npmBin: string
  pathEnv: string
} {
  const nodePath = makeFile(join(root, 'node-bin', 'node.exe'))
  const npmBin = join(root, 'npm-bin')
  mkdirSync(npmBin, { recursive: true })
  return { nodePath, npmBin, pathEnv: [npmBin, dirname(nodePath)].join(delimiter) }
}

function makePackagedCodex(
  npmBin: string,
  shim: 'cmd' | 'ps1' = 'cmd'
): {
  nativeCodex: string
  packageRoot: string
} {
  makeFile(
    join(npmBin, `codex.${shim}`),
    shim === 'cmd' ? CANONICAL_NPM_CMD_SHIM : CANONICAL_NPM_POWERSHELL_SHIM
  )
  const packageRoot = join(npmBin, 'node_modules', '@openai', 'codex')
  makeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: '@openai/codex',
      version: '0.0.0-test',
      bin: { codex: 'bin/codex.js' },
      optionalDependencies: {
        '@openai/codex-win32-x64': 'npm:@openai/codex@0.0.0-test-win32-x64'
      }
    })
  )
  makeFile(join(packageRoot, 'bin', 'codex.js'), TRUSTED_CODEX_ENTRYPOINT)
  const platformPackageRoot = join(packageRoot, 'node_modules', '@openai', 'codex-win32-x64')
  makeFile(
    join(platformPackageRoot, 'package.json'),
    JSON.stringify({ name: '@openai/codex', version: '0.0.0-test-win32-x64' })
  )
  return {
    packageRoot,
    nativeCodex: makeFile(
      join(platformPackageRoot, 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
    )
  }
}

function buildAttempt(args: {
  root: string
  command: string
  launchAgent?: string
  pathEnv: string
  arch?: string
  eligible?: boolean
  env?: Record<string, string>
}) {
  const powerShellLaunch = resolveWindowsShellLaunchArgs(
    POWER_SHELL,
    CWD,
    DEFAULT_CWD,
    undefined,
    args.command
  )
  return buildWindowsCodexShellHandoffAttempt({
    fallbackAttempts: [
      {
        shellPath: POWER_SHELL,
        shellArgs: powerShellLaunch.shellArgs,
        effectiveCwd: powerShellLaunch.effectiveCwd,
        validationCwd: powerShellLaunch.validationCwd,
        startupCommandDeliveredInShellArgs:
          powerShellLaunch.startupCommandDeliveredInShellArgs === true
      }
    ],
    cwd: CWD,
    defaultCwd: DEFAULT_CWD,
    startupCommand: args.command,
    launchAgent: args.launchAgent ?? 'codex',
    windowsCodexShellHandoff: args.eligible ?? true,
    env: { PATH: args.pathEnv, PATHEXT: DEFAULT_PATH_EXT, ...args.env },
    resolveOptions: {
      platform: 'win32',
      arch: args.arch ?? 'x64',
      pathEnv: args.pathEnv
    }
  })
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('isCanonicalCodexPackageShim', () => {
  it('accepts only newline-normalized copies of the known npm templates', () => {
    const root = makeTempRoot()
    const cmdPath = makeFile(
      join(root, 'codex.cmd'),
      `\uFEFF${CANONICAL_NPM_CMD_SHIM.replace(/\n/g, '\r\n')}`
    )
    const powerShellPath = makeFile(join(root, 'codex.ps1'), CANONICAL_NPM_POWERSHELL_SHIM)

    expect(isCanonicalCodexPackageShim(cmdPath)).toBe(true)
    expect(isCanonicalCodexPackageShim(powerShellPath)).toBe(true)
  })

  it.each([
    ['cmd comment', 'codex.cmd', `REM company policy\n${CANONICAL_NPM_CMD_SHIM}`],
    ['cmd executable hash line', 'codex.cmd', `${CANONICAL_NPM_CMD_SHIM}# & wrapper.exe\n`],
    ['cmd alternate target', 'codex.cmd', CANONICAL_NPM_CMD_SHIM.replace('codex.js', 'wrapper.js')],
    ['PowerShell comment', 'codex.ps1', `${CANONICAL_NPM_POWERSHELL_SHIM}# company policy\n`],
    [
      'PowerShell dead code',
      'codex.ps1',
      `${CANONICAL_NPM_POWERSHELL_SHIM}if ($false) { & 'wrapper.exe' }\n`
    ]
  ])('rejects a canonical-looking shim with $name', (_name, fileName, contents) => {
    const commandPath = makeFile(join(makeTempRoot(), fileName), contents)

    expect(isCanonicalCodexPackageShim(commandPath)).toBe(false)
  })
})

describe('buildWindowsCodexShellHandoffAttempt', () => {
  it('carries generated Codex argv losslessly and defers the selected PowerShell', () => {
    const root = makeTempRoot()
    const { nodePath, npmBin, pathEnv } = makeBasePaths(root)
    const codexPath = makeFile(join(npmBin, 'codex.exe'))
    const command =
      "codex '--flag' 'line one\nline two with %PATH%, !, `code`, Ω, and it''s quoted'"

    const attempt = buildAttempt({ root, command, pathEnv })

    expect(attempt).not.toBeNull()
    expect(attempt?.shellPath).toBe(nodePath)
    expect(attempt?.logicalShellPath).toBe(POWER_SHELL)
    expect(attempt?.startupCommandDeliveredInShellArgs).toBe(true)
    const config = decodeWindowsCodexShellHandoffConfig(attempt!)
    expect(config.agentFile.toLowerCase()).toBe(codexPath.toLowerCase())
    expect(config.agentArgs).toEqual([
      '--flag',
      "line one\nline two with %PATH%, !, `code`, Ω, and it's quoted"
    ])
    expect(config.shellAttempts).toHaveLength(1)
    expect(config.shellAttempts[0]).toMatchObject({ file: POWER_SHELL, cwd: CWD })
    expect(config.shellAttempts[0].args).toContain('-NoExit')
    expect(config.shellAttempts[0].args).toContain('-EncodedCommand')
    expect(config.agentFallbackAttempts[0]).toMatchObject({ file: POWER_SHELL, cwd: CWD })
    expect(config.agentFallbackAttempts[0].args).toContain('-EncodedCommand')
  })

  it('resolves an npm shim to its matching packaged native binary and managed env', () => {
    const root = makeTempRoot()
    const { npmBin, pathEnv } = makeBasePaths(root)
    const { nativeCodex, packageRoot } = makePackagedCodex(npmBin)

    const attempt = buildAttempt({ root, command: "codex '--version'", pathEnv })

    expect(attempt).not.toBeNull()
    const config = decodeWindowsCodexShellHandoffConfig(attempt!)
    expect(config.agentFile).toBe(nativeCodex)
    expect(config.agentEnv).toMatchObject({
      CODEX_MANAGED_PACKAGE_ROOT: realpathSync(packageRoot),
      CODEX_MANAGED_BY_NPM: '1'
    })
    expect(config.agentEnvToDelete).toEqual([
      'CODEX_MANAGED_BY_NPM',
      'CODEX_MANAGED_BY_PNPM',
      'CODEX_MANAGED_BY_BUN'
    ])
  })

  it('only marks pnpm when the discovered node_modules owns this Codex package', () => {
    const root = makeTempRoot()
    const { npmBin, pathEnv } = makeBasePaths(root)
    makePackagedCodex(npmBin)
    makeFile(join(npmBin, 'node_modules', '.modules.yaml'))

    const attempt = buildAttempt({ root, command: "codex '--version'", pathEnv })

    expect(decodeWindowsCodexShellHandoffConfig(attempt!).agentEnv).toMatchObject({
      CODEX_MANAGED_BY_PNPM: '1'
    })
  })

  it('marks Bun global installs without relying on transient npm environment variables', () => {
    const root = makeTempRoot()
    const bunBin = join(root, '.bun', 'install', 'global', 'bin')
    const nodePath = makeFile(join(root, 'node-bin', 'node.exe'))
    makePackagedCodex(bunBin)
    const pathEnv = [bunBin, dirname(nodePath)].join(delimiter)

    const attempt = buildAttempt({ root, command: "codex '--version'", pathEnv })

    expect(decodeWindowsCodexShellHandoffConfig(attempt!).agentEnv).toMatchObject({
      CODEX_MANAGED_BY_BUN: '1'
    })
  })

  it.each([
    { name: 'custom compound command', command: "codex --profile work 'fix it'", agent: 'codex' },
    { name: 'PowerShell call operator', command: "& 'codex' 'fix it'", agent: 'codex' },
    { name: 'different launch owner', command: "codex 'fix it'", agent: 'claude' },
    { name: 'unclosed generated quote', command: "codex 'fix it", agent: 'codex' },
    { name: 'leading whitespace', command: " codex 'fix it'", agent: 'codex' },
    { name: 'trailing whitespace', command: "codex 'fix it' ", agent: 'codex' },
    { name: 'repeated whitespace', command: "codex  'fix it'", agent: 'codex' },
    { name: 'tab separator', command: "codex\t'fix it'", agent: 'codex' }
  ])('keeps the existing PowerShell path for $name', ({ command, agent }) => {
    const root = makeTempRoot()
    const { npmBin, pathEnv } = makeBasePaths(root)
    makeFile(join(npmBin, 'codex.exe'))

    expect(buildAttempt({ root, command, launchAgent: agent, pathEnv })).toBeNull()
  })

  it('keeps a canonical-looking custom command on the existing PowerShell path', () => {
    const root = makeTempRoot()
    const { npmBin, pathEnv } = makeBasePaths(root)
    makeFile(join(npmBin, 'codex.exe'))

    expect(buildAttempt({ root, command: "codex 'fix it'", pathEnv, eligible: false })).toBeNull()
  })

  it('rejects a package shim shadowed by a noncanonical PowerShell shim', () => {
    const root = makeTempRoot()
    const { npmBin, pathEnv } = makeBasePaths(root)
    makePackagedCodex(npmBin)
    makeFile(join(npmBin, 'codex.ps1'), "Write-Output 'enterprise wrapper'")

    expect(buildAttempt({ root, command: "codex 'fix it'", pathEnv })).toBeNull()
  })

  it('resolves the canonical npm PowerShell shim selected ahead of its cmd pair', () => {
    const root = makeTempRoot()
    const { npmBin, pathEnv } = makeBasePaths(root)
    makeFile(join(npmBin, 'codex.cmd'), CANONICAL_NPM_CMD_SHIM)
    const { nativeCodex } = makePackagedCodex(npmBin, 'ps1')

    const attempt = buildAttempt({ root, command: "codex '--version'", pathEnv })

    expect(attempt).not.toBeNull()
    expect(decodeWindowsCodexShellHandoffConfig(attempt!).agentFile).toBe(nativeCodex)
  })

  it('uses the same-directory executable PowerShell selects before a cmd shim', () => {
    const root = makeTempRoot()
    const { npmBin, pathEnv } = makeBasePaths(root)
    makeFile(join(npmBin, 'codex.cmd'), CANONICAL_NPM_CMD_SHIM)
    const codexExe = makeFile(join(npmBin, 'codex.exe'))

    const attempt = buildAttempt({ root, command: "codex '--version'", pathEnv })

    expect(attempt).not.toBeNull()
    expect(decodeWindowsCodexShellHandoffConfig(attempt!).agentFile.toLowerCase()).toBe(
      codexExe.toLowerCase()
    )
  })

  it('keeps PowerShell when an earlier PATH directory contains a custom shim', () => {
    const root = makeTempRoot()
    const { npmBin, pathEnv } = makeBasePaths(root)
    makePackagedCodex(npmBin)
    const enterpriseBin = join(root, 'enterprise-bin')
    makeFile(join(enterpriseBin, 'codex.ps1'), "& 'company-wrapper.exe' @args")

    expect(
      buildAttempt({
        root,
        command: "codex 'fix it'",
        pathEnv: [enterpriseBin, pathEnv].join(delimiter)
      })
    ).toBeNull()
  })

  it('keeps PowerShell when custom PATHEXT selects a batch wrapper first', () => {
    const root = makeTempRoot()
    const { npmBin, pathEnv } = makeBasePaths(root)
    makePackagedCodex(npmBin)
    makeFile(join(npmBin, 'codex.bat'), '@echo off\r\ncompany-wrapper.exe %*\r\n')

    expect(
      buildAttempt({
        root,
        command: "codex 'fix it'",
        pathEnv,
        env: { PATHEXT: '.BAT;.CMD;.EXE' }
      })
    ).toBeNull()
  })

  it('rejects executable text added to an otherwise canonical cmd shim', () => {
    const root = makeTempRoot()
    const { npmBin, pathEnv } = makeBasePaths(root)
    makePackagedCodex(npmBin)
    makeFile(join(npmBin, 'codex.cmd'), `${CANONICAL_NPM_CMD_SHIM}# & company-wrapper.exe\n`)

    expect(buildAttempt({ root, command: "codex 'fix it'", pathEnv })).toBeNull()
  })

  it('rejects package metadata that redirects the Codex bin entry', () => {
    const root = makeTempRoot()
    const { npmBin, pathEnv } = makeBasePaths(root)
    const { packageRoot } = makePackagedCodex(npmBin)
    makeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/company-wrapper.js' } })
    )

    expect(buildAttempt({ root, command: "codex 'fix it'", pathEnv })).toBeNull()
  })

  it('rejects a modified Codex JavaScript entrypoint before bypassing it', () => {
    const root = makeTempRoot()
    const { npmBin, pathEnv } = makeBasePaths(root)
    const { packageRoot } = makePackagedCodex(npmBin)
    makeFile(
      join(packageRoot, 'bin', 'codex.js'),
      `${TRUSTED_CODEX_ENTRYPOINT}\nconsole.log('company wrapper')\n`
    )

    expect(buildAttempt({ root, command: "codex 'fix it'", pathEnv })).toBeNull()
  })

  it('does not infer default executable extensions when PATHEXT is absent', () => {
    const root = makeTempRoot()
    const { npmBin, pathEnv } = makeBasePaths(root)
    makeFile(join(npmBin, 'codex.exe'))

    expect(
      buildWindowsCodexShellHandoffAttempt({
        fallbackAttempts: [
          {
            shellPath: POWER_SHELL,
            shellArgs: [],
            effectiveCwd: CWD,
            validationCwd: CWD,
            startupCommandDeliveredInShellArgs: false
          }
        ],
        cwd: CWD,
        defaultCwd: DEFAULT_CWD,
        startupCommand: "codex 'fix it'",
        launchAgent: 'codex',
        windowsCodexShellHandoff: true,
        env: { PATH: pathEnv },
        resolveOptions: { platform: 'win32', arch: 'x64', pathEnv }
      })
    ).toBeNull()
  })

  it('keeps the existing PowerShell path when the exact Codex target is unresolved', () => {
    const root = makeTempRoot()
    const { pathEnv } = makeBasePaths(root)

    expect(buildAttempt({ root, command: "codex 'fix it'", pathEnv })).toBeNull()
  })

  it('keeps oversized launch payloads below the Windows CreateProcess limit', () => {
    const root = makeTempRoot()
    const { npmBin, pathEnv } = makeBasePaths(root)
    makeFile(join(npmBin, 'codex.exe'))

    expect(buildAttempt({ root, command: `codex '${'x'.repeat(30_000)}'`, pathEnv })).toBeNull()
  })

  it('keeps a 6,001-character command in every async PowerShell fallback', () => {
    const root = makeTempRoot()
    const { npmBin, pathEnv } = makeBasePaths(root)
    makeFile(join(npmBin, 'codex.exe'))
    const command = `codex '${'x'.repeat(6_001)}'`

    const attempt = buildAttempt({ root, command, pathEnv })

    expect(attempt).not.toBeNull()
    const config = decodeWindowsCodexShellHandoffConfig(attempt!)
    expect(config.agentFallbackAttempts).toHaveLength(1)
    const fallbackCommand = Buffer.from(
      config.agentFallbackAttempts[0].args[3] ?? '',
      'base64'
    ).toString('utf16le')
    expect(fallbackCommand.trimEnd().endsWith(command)).toBe(true)
  })

  it('rejects handoff commands that no shell fallback can embed safely', () => {
    const root = makeTempRoot()
    const { npmBin, pathEnv } = makeBasePaths(root)
    makeFile(join(npmBin, 'codex.exe'))

    expect(buildAttempt({ root, command: `codex '${'x'.repeat(12_000)}'`, pathEnv })).toBeNull()
  })

  it('accounts for Windows quote escaping at the native child boundary', () => {
    const root = makeTempRoot()
    const { npmBin, pathEnv } = makeBasePaths(root)
    makeFile(join(npmBin, 'codex.exe'))

    expect(buildAttempt({ root, command: `codex '${'"'.repeat(16_000)}'`, pathEnv })).toBeNull()
  })
})

describe('WINDOWS_CODEX_SHELL_HANDOFF_HOST_SCRIPT', () => {
  it('runs the agent before the shell without leaking agent-only env', () => {
    const config: WindowsCodexShellHandoffConfig = {
      agentFile: process.execPath,
      agentArgs: [
        '-e',
        "process.stdout.write('agent:' + process.env.ORCA_HANDOFF_AGENT_ONLY + '\\n')"
      ],
      agentEnvToDelete: [],
      agentEnv: { ORCA_HANDOFF_AGENT_ONLY: 'yes' },
      shellAttempts: [
        {
          file: process.execPath,
          args: [
            '-e',
            "process.stdout.write('shell:' + String(process.env.ORCA_HANDOFF_AGENT_ONLY) + '\\n')"
          ],
          cwd: process.cwd()
        }
      ],
      agentFallbackAttempts: [
        {
          file: process.execPath,
          args: ['-e', "process.stdout.write('agent-fallback\\n')"],
          cwd: process.cwd()
        }
      ]
    }
    const encoded = encodeWindowsCodexShellHandoffConfig(config)

    const result = spawnSync(
      process.execPath,
      ['-e', WINDOWS_CODEX_SHELL_HANDOFF_HOST_SCRIPT, encoded],
      {
        encoding: 'utf8',
        env: { ...process.env, ORCA_HANDOFF_AGENT_ONLY: undefined },
        timeout: 5_000
      }
    )

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('agent:yes\nshell:undefined\n')
  })

  it('uses the original shell command when the native agent fails to spawn', () => {
    const config: WindowsCodexShellHandoffConfig = {
      agentFile: join(makeTempRoot(), 'missing-codex.exe'),
      agentArgs: [],
      agentEnvToDelete: [],
      agentEnv: {},
      shellAttempts: [],
      agentFallbackAttempts: [
        {
          file: process.execPath,
          args: ['-e', "process.stdout.write('fallback\\n')"],
          cwd: process.cwd()
        }
      ]
    }
    const encoded = encodeWindowsCodexShellHandoffConfig(config)

    const result = spawnSync(
      process.execPath,
      ['-e', WINDOWS_CODEX_SHELL_HANDOFF_HOST_SCRIPT, encoded],
      { encoding: 'utf8', timeout: 5_000 }
    )

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('Failed to launch')
    expect(result.stdout).toBe('fallback\n')
  })

  it('tries only the supplied PowerShell-family command fallbacks after an async spawn error', () => {
    const prompt = 'fix spaced & piped | redirected < input > output 100%'
    const config: WindowsCodexShellHandoffConfig = {
      agentFile: join(makeTempRoot(), 'missing-codex.exe'),
      agentArgs: [prompt],
      agentEnvToDelete: [],
      agentEnv: {},
      shellAttempts: [],
      agentFallbackAttempts: [
        {
          file: join(makeTempRoot(), 'missing-pwsh.exe'),
          args: [],
          cwd: process.cwd()
        },
        {
          file: process.execPath,
          args: ['-e', 'process.stdout.write(process.argv[1])', prompt],
          cwd: process.cwd()
        }
      ]
    }
    const encoded = encodeWindowsCodexShellHandoffConfig(config)

    const result = spawnSync(
      process.execPath,
      ['-e', WINDOWS_CODEX_SHELL_HANDOFF_HOST_SCRIPT, encoded],
      { encoding: 'utf8', timeout: 5_000 }
    )

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('Failed to launch')
    expect(result.stdout).toBe(prompt)
  })

  it('opens the normal shell after a nonzero agent exit without relaunching the agent', () => {
    const config: WindowsCodexShellHandoffConfig = {
      agentFile: process.execPath,
      agentArgs: ['-e', 'process.exitCode = 7'],
      agentEnvToDelete: [],
      agentEnv: {},
      shellAttempts: [
        {
          file: process.execPath,
          args: ['-e', "process.stdout.write('shell\\n')"],
          cwd: process.cwd()
        }
      ],
      agentFallbackAttempts: [
        {
          file: process.execPath,
          args: ['-e', "process.stdout.write('wrong\\n')"],
          cwd: process.cwd()
        }
      ]
    }
    const encoded = encodeWindowsCodexShellHandoffConfig(config)

    const result = spawnSync(
      process.execPath,
      ['-e', WINDOWS_CODEX_SHELL_HANDOFF_HOST_SCRIPT, encoded],
      { encoding: 'utf8', timeout: 5_000 }
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('shell\n')
  })

  it('tries the remaining shell-only fallback after a shell spawn error', () => {
    const config: WindowsCodexShellHandoffConfig = {
      agentFile: process.execPath,
      agentArgs: ['-e', ''],
      agentEnvToDelete: [],
      agentEnv: {},
      shellAttempts: [
        { file: join(makeTempRoot(), 'missing-pwsh.exe'), args: [], cwd: process.cwd() },
        {
          file: process.execPath,
          args: ['-e', "process.stdout.write('second-shell\\n')"],
          cwd: process.cwd()
        }
      ],
      agentFallbackAttempts: []
    }
    const encoded = encodeWindowsCodexShellHandoffConfig(config)

    const result = spawnSync(
      process.execPath,
      ['-e', WINDOWS_CODEX_SHELL_HANDOFF_HOST_SCRIPT, encoded],
      { encoding: 'utf8', timeout: 5_000 }
    )

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('Failed to launch')
    expect(result.stdout).toBe('second-shell\n')
  })
})
