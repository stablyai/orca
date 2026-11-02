import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { encodePowerShellCommand } from './powershell-osc133-bootstrap'
import { resolveWindowsShellLaunchArgs } from './providers/windows-shell-args'

const WINDOWS_POWERSHELLS = ['powershell.exe', 'pwsh.exe'] as const
const PROFILE_CODEX_HOME = 'C:\\Profile Custom\\codex'
const MANAGED_CODEX_HOME = 'C:\\Orca Managed\\codex-runtime-home'

for (const shell of WINDOWS_POWERSHELLS) {
  describe.runIf(isAvailable(shell))(`${shell} managed home bootstrap`, () => {
    it.each(['FullLanguage', 'ConstrainedLanguage'] as const)(
      'restores CODEX_HOME and continues startup in %s mode',
      (languageMode) => {
        const cwd = mkdtempSync(join(tmpdir(), 'orca-powershell-clm-'))
        try {
          expect(runBootstrap(shell, languageMode, cwd)).toContain(
            `mode=${languageMode};codexHome=${MANAGED_CODEX_HOME};orcaHome=${MANAGED_CODEX_HOME};startupCount=2;cwd=${cwd}`
          )
        } finally {
          rmSync(cwd, { recursive: true, force: true })
        }
      }
    )
  })
}

function runBootstrap(
  shell: (typeof WINDOWS_POWERSHELLS)[number],
  languageMode: 'FullLanguage' | 'ConstrainedLanguage',
  cwd: string
): string {
  const launch = resolveWindowsShellLaunchArgs(
    shell,
    cwd,
    process.env.USERPROFILE ?? cwd,
    undefined,
    '$env:ORCA_TEST_STARTUP_COUNT = 1 + [int]$env:ORCA_TEST_STARTUP_COUNT'
  )
  expect(launch.startupCommandDeliveredInShellArgs).toBe(true)
  const encodedCommandIndex = launch.shellArgs.indexOf('-EncodedCommand')
  expect(encodedCommandIndex).toBeGreaterThanOrEqual(0)
  const encodedCommand = launch.shellArgs[encodedCommandIndex + 1]
  expect(encodedCommand).toBeTruthy()

  return execFileSync(
    shell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', harness],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_HOME: PROFILE_CODEX_HOME,
        ORCA_CODEX_HOME: MANAGED_CODEX_HOME,
        ORCA_TEST_BOOTSTRAP: encodedCommand,
        ORCA_TEST_LANGUAGE_MODE: languageMode
      },
      windowsHide: true
    }
  )
}

function isAvailable(shell: (typeof WINDOWS_POWERSHELLS)[number]): boolean {
  if (process.platform !== 'win32') {
    return false
  }
  try {
    execFileSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$null'], {
      stdio: 'ignore',
      windowsHide: true
    })
    return true
  } catch {
    return false
  }
}

const harness = encodePowerShellCommand(`
$initialState = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
$initialState.LanguageMode = $env:ORCA_TEST_LANGUAGE_MODE
$runspace = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace($initialState)
$runspace.Open()
$runner = [System.Management.Automation.PowerShell]::Create()
$runner.Runspace = $runspace
$bootstrap = [Text.Encoding]::Unicode.GetString(
  [Convert]::FromBase64String($env:ORCA_TEST_BOOTSTRAP)
)
$null = $runner.AddScript($bootstrap).Invoke()
$runner.Commands.Clear()
$null = $runner.AddScript($bootstrap).Invoke()
$runner.Commands.Clear()
$runner.AddScript(
  '"mode=$($ExecutionContext.SessionState.LanguageMode);codexHome=$env:CODEX_HOME;orcaHome=$env:ORCA_CODEX_HOME;startupCount=$env:ORCA_TEST_STARTUP_COUNT;cwd=$($PWD.Path)"'
).Invoke()
$runner.Dispose()
$runspace.Dispose()
`)
