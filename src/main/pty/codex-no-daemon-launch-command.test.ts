import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { planCodexNoDaemonLaunch, type LocalCodexLaunch } from './codex-no-daemon-launch-command'

const HELP_WITH_FLAG = 'Usage: codex [OPTIONS] [PROMPT]\n      --no-daemon  Run in-process\n'
const HELP_WITHOUT_FLAG = 'Usage: codex [OPTIONS] [PROMPT]\n      --no-alt-screen\n'
const CMD_TAR_SCOPE_WRAPPER =
  '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "PATH=%~dp0;%PATH%"\r\ncall %*\r\nexit /b %errorlevel%\r\n'
const hostPlatform = process.platform

describe.skipIf(hostPlatform !== 'win32')('Windows Codex tar launch scope', () => {
  function plan(command: string, shellOverride: string, env: Record<string, string>) {
    return planCodexNoDaemonLaunch({
      command,
      executesOnThisHost: true,
      shellOverride,
      env,
      cwd: undefined
    })
  }

  it('scopes a cmd.exe shared-server launch', async () => {
    await expect(
      plan('codex --remote ws://host', 'cmd.exe', {
        ORCA_CODEX_WINDOWS_TAR_SHIM_DIR: 'C:\\Orca Data\\tar-shim'
      })
    ).resolves.toBe(
      'call "%ORCA_CODEX_WINDOWS_TAR_SHIM_DIR%\\codex-tar-scope.cmd" codex --remote ws://host'
    )
  })

  it('restores PATH and preserves a scoped cmd.exe Codex failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-codex-cmd-tar-scope-'))
    writeFileSync(join(dir, 'codex.cmd'), '@exit /b 42\r\n')
    writeFileSync(join(dir, 'codex-tar-scope.cmd'), CMD_TAR_SCOPE_WRAPPER)
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key.toLowerCase() !== 'path') {
        env[key] = value
      }
    }
    env.Path = `${dir};C:\\Program Files (x86)\\Tools;${process.env.Path ?? process.env.PATH ?? ''}`
    env.ORCA_CODEX_WINDOWS_TAR_SHIM_DIR = dir

    try {
      const command = await plan('codex --remote ws://host', 'cmd.exe', env)
      const result = await runProcess({
        program: 'cmd.exe',
        args: ['/d'],
        cwd: dir,
        env,
        input: `${command}\r\nset "ORCA_TEST_EXIT=%errorlevel%"\r\necho after=%PATH%\r\nexit %ORCA_TEST_EXIT%\r\n`
      })

      expect(result.code).toBe(42)
      expect(result.stdout).toContain(`after=${env.Path}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('scopes a quoted cmd.exe executable and argument', async () => {
    const command = '"C:\\Program Files\\Codex\\codex.cmd" --remote "ws://host/path with space"'

    await expect(
      plan(command, 'cmd.exe', {
        ORCA_CODEX_WINDOWS_TAR_SHIM_DIR: 'C:\\Orca Data\\tar-shim'
      })
    ).resolves.toBe(`call "%ORCA_CODEX_WINDOWS_TAR_SHIM_DIR%\\codex-tar-scope.cmd" ${command}`)
  })

  it('scopes a path-named PowerShell shared-server launch', async () => {
    const codex = 'C:\\Tools\\codex.exe'

    await expect(
      plan(`${codex} --remote ws://host`, 'powershell.exe', {
        ORCA_CODEX_WINDOWS_TAR_SHIM_DIR: 'C:\\Orca Data\\tar-shim'
      })
    ).resolves.toBe(
      `& { $orcaCodexOriginalPath = $env:Path; try { $env:Path = "$env:ORCA_CODEX_WINDOWS_TAR_SHIM_DIR;$env:Path"; ${codex} --remote ws://host } finally { $env:Path = $orcaCodexOriginalPath } }; if ($LASTEXITCODE -ne 0) { Write-Error 'failure' -ErrorAction Ignore }`
    )
  })

  it.each([
    [0, 'True'],
    [42, 'False']
  ])('restores PATH and preserves PowerShell success for exit %i', async (exitCode, success) => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-codex-powershell-tar-scope-'))
    const codex = join(dir, 'codex.cmd')
    writeFileSync(codex, '@exit /b %ORCA_TEST_CODE%\r\n')
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key.toLowerCase() !== 'path') {
        env[key] = value
      }
    }
    env.Path = process.env.Path ?? process.env.PATH ?? ''
    env.ORCA_CODEX_WINDOWS_TAR_SHIM_DIR = dir
    env.ORCA_TEST_CODE = String(exitCode)

    try {
      const command = await plan(`${codex} --remote ws://host`, 'powershell.exe', env)
      const result = await runProcess({
        program: 'powershell.exe',
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Set-StrictMode -Version Latest; ${command}; "SUCCESS=$?;LAST=$LASTEXITCODE;PATH=$env:Path"`
        ],
        cwd: dir,
        env
      })

      expect(result.stdout).toContain(`SUCCESS=${success};LAST=${exitCode};PATH=${env.Path}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('scopes a path-named Git Bash launch after adding --no-daemon', async () => {
    // Why: Windows TMP is often 8.3 (RUNNER~1), and `~` makes Git Bash launches skip scoping.
    const dir = mkdtempSync(join(realpathSync.native(tmpdir()), 'orca-codex-posix-tar-scope-'))
    const codex = join(dir, 'codex.cmd')
    writeFileSync(codex, '@echo off\r\necho --no-daemon\r\n')
    const shellPath = codex.replaceAll('\\', '/')

    try {
      const result = await plan(`'${shellPath}' --yolo`, 'git-bash', {
        ORCA_CODEX_WINDOWS_TAR_SHIM_DIR: 'C:\\Orca Data\\tar-shim'
      })

      expect(result).toContain('sh -c ')
      expect(result).toContain('cygpath -u')
      expect(result).toContain('"$ORCA_CODEX_WINDOWS_TAR_SHIM_DIR"')
      expect(result).toContain(`'${shellPath}' '--no-daemon' '--yolo'`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('scopes a path-named Git Bash shared-server launch', async () => {
    const codex = '/c/Program Files/Codex/codex.exe'
    const result = await plan(`'${codex}' --remote ws://host`, 'git-bash', {
      ORCA_CODEX_WINDOWS_TAR_SHIM_DIR: 'C:\\Orca Data\\tar-shim'
    })

    expect(result).toContain('sh -c ')
    expect(result).toContain('cygpath -u')
    expect(result).toContain('"$ORCA_CODEX_WINDOWS_TAR_SHIM_DIR"')
    expect(result).toContain(`'${codex}' '--remote' 'ws://host'`)
  })

  it('fails open instead of rebuilding divergent Git Bash argv', () => {
    expect(
      plan("'/c/Tools/codex.exe' --remote ws://host; echo untouched", 'git-bash', {
        ORCA_CODEX_WINDOWS_TAR_SHIM_DIR: 'C:\\Orca Data\\tar-shim'
      })
    ).toBeNull()
  })

  it.each([
    ['cmd.exe', 'codex --remote ws://host & echo untouched'],
    ['powershell.exe', 'C:\\Tools\\codex.exe --remote ws://host; Write-Output untouched'],
    ['cmd.exe', 'codex --remote ws://host\r\necho untouched'],
    ['powershell.exe', 'C:\\Tools\\codex.exe --remote ws://host\r\nWrite-Output untouched'],
    ['git-bash', "'/c/Tools/codex.exe' --remote ws://host\r\necho untouched"]
  ])('does not extend the tar scope across a compound %s command', (shell, command) => {
    expect(
      plan(command, shell, {
        ORCA_CODEX_WINDOWS_TAR_SHIM_DIR: 'C:\\Orca Data\\tar-shim'
      })
    ).toBeNull()
  })

  it('does not make a POSIX shell expansion literal', () => {
    expect(
      plan('\'/c/Tools/codex.exe\' --remote "$CODEX_REMOTE_HOST"', 'git-bash', {
        ORCA_CODEX_WINDOWS_TAR_SHIM_DIR: 'C:\\Orca Data\\tar-shim'
      })
    ).toBeNull()
  })

  it('does not wrap PowerShell stop-parsing syntax', () => {
    expect(
      plan('C:\\Tools\\codex.exe --% --remote ws://host', 'powershell.exe', {
        ORCA_CODEX_WINDOWS_TAR_SHIM_DIR: 'C:\\Orca Data\\tar-shim'
      })
    ).toBeNull()
  })

  it.each(['codex --remote ws://host "foo&bar"', 'codex --remote %CODEX_REMOTE_HOST%'])(
    'does not reparse a sensitive cmd.exe launch: %s',
    (command) => {
      expect(
        plan(command, 'cmd.exe', {
          ORCA_CODEX_WINDOWS_TAR_SHIM_DIR: 'C:\\Orca Data\\tar-shim'
        })
      ).toBeNull()
    }
  )

  it('does not reparse a sensitive cmd.exe shim directory', () => {
    expect(
      plan('codex --remote ws://host', 'cmd.exe', {
        ORCA_CODEX_WINDOWS_TAR_SHIM_DIR: 'C:\\shim&bad'
      })
    ).toBeNull()
  })

  it('leaves a path-named Git Bash launch unchanged when the setting inherits PATH', () => {
    expect(plan("'/c/Tools/codex.exe' --remote ws://host", 'git-bash', {})).toBeNull()
  })

  it('leaves cmd.exe unchanged when the setting inherits PATH', () => {
    expect(plan('codex --remote ws://host', 'cmd.exe', {})).toBeNull()
  })

  it('leaves cmd.exe unchanged when the pane deletes an inherited marker', () => {
    expect(
      planCodexNoDaemonLaunch({
        command: 'codex --remote ws://host',
        executesOnThisHost: true,
        shellOverride: 'cmd.exe',
        env: { ORCA_CODEX_WINDOWS_TAR_SHIM_DIR: 'C:\\stale' },
        envToDelete: ['ORCA_CODEX_WINDOWS_TAR_SHIM_DIR'],
        cwd: undefined
      })
    ).toBeNull()
  })
})

describe.skipIf(hostPlatform === 'win32')('planCodexNoDaemonLaunch', () => {
  let dir: string
  let codex: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-codex-no-daemon-launch-'))
    codex = writeCodex('codex', HELP_WITH_FLAG)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  function writeCodex(name: string, help: string): string {
    const path = join(dir, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `#!/bin/sh\nprintf '%s' '${help}'\n`)
    chmodSync(path, 0o755)
    return path
  }

  function plan(command: string, overrides: Partial<LocalCodexLaunch> = {}) {
    return planCodexNoDaemonLaunch({
      command,
      executesOnThisHost: true,
      shellOverride: undefined,
      env: {},
      cwd: dir,
      ...overrides
    })
  }

  it('adds --no-daemon once, right after a path-named codex', async () => {
    await expect(plan(`${codex} --yolo 'fix the bug'`)).resolves.toBe(
      `${codex} --no-daemon --yolo 'fix the bug'`
    )
  })

  it.each([
    ['agents'],
    ['queue --thread T'],
    ['--no-daemon'],
    ['resume --no-daemon'],
    ['--remote unix://'],
    ['--remote=ws://h:1']
  ])('leaves `codex %s` alone: it needs the shared server or has the flag', (args) => {
    expect(plan(`${codex} ${args}`)).toBeNull()
  })

  it('leaves SSH and WSL launches to the codex function on that host', () => {
    expect(plan(`${codex} --yolo`, { executesOnThisHost: false })).toBeNull()
  })

  it('ignores an inherited opt-out the pane deletes', async () => {
    vi.stubEnv('ORCA_CODEX_ISOLATE', '0')

    await expect(plan(`${codex} --yolo`, { envToDelete: ['ORCA_CODEX_ISOLATE'] })).resolves.toBe(
      `${codex} --no-daemon --yolo`
    )
  })

  it('honours ORCA_CODEX_ISOLATE=0 from the pane env', () => {
    expect(plan(`${codex} --yolo`, { env: { ORCA_CODEX_ISOLATE: '0' } })).toBeNull()
  })

  it('keeps the command when the binary predates --no-daemon', async () => {
    const oldCodex = writeCodex('0.155/codex', HELP_WITHOUT_FLAG)

    await expect(plan(`${oldCodex} --yolo`)).resolves.toBe(`${oldCodex} --yolo`)
  })

  it.each([['codex --yolo'], ['claude --yolo'], ['/opt/bin/codexx --yolo']])(
    'leaves `%s` to the shell function or to another agent',
    (command) => {
      expect(plan(command)).toBeNull()
    }
  )

  it('probes a bare codex on PATH for cmd.exe, which has no codex function', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    writeCodex('codex.exe', HELP_WITH_FLAG)

    await expect(
      plan('codex --yolo', {
        shellOverride: 'cmd.exe',
        env: { PATH: dir, PATHEXT: '.exe' }
      })
    ).resolves.toBe('codex --no-daemon --yolo')
  })

  it('scopes the Windows tar shim around a cmd.exe shared-server launch', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    writeCodex('codex.exe', HELP_WITH_FLAG)

    await expect(
      plan('codex --remote ws://host', {
        shellOverride: 'cmd.exe',
        env: {
          ORCA_CODEX_WINDOWS_TAR_SHIM_DIR: 'C:\\Orca Data\\tar-shim',
          PATH: dir,
          PATHEXT: '.exe'
        }
      })
    ).resolves.toBe(
      'call "%ORCA_CODEX_WINDOWS_TAR_SHIM_DIR%\\codex-tar-scope.cmd" codex --remote ws://host'
    )
  })

  it('scopes the Windows tar shim around a path-named PowerShell launch', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    await expect(
      plan(`${codex} --remote ws://host`, {
        shellOverride: 'powershell.exe',
        env: { ORCA_CODEX_WINDOWS_TAR_SHIM_DIR: 'C:\\Orca Data\\tar-shim' }
      })
    ).resolves.toBe(
      `& { $orcaCodexOriginalPath = $env:Path; try { $env:Path = "$env:ORCA_CODEX_WINDOWS_TAR_SHIM_DIR;$env:Path"; ${codex} --remote ws://host } finally { $env:Path = $orcaCodexOriginalPath } }`
    )
  })
})
