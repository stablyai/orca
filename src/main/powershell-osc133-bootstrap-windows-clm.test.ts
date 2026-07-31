import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap
} from './powershell-osc133-bootstrap'

const WINDOWS_POWERSHELLS = ['powershell.exe', 'pwsh.exe'] as const
const PROFILE_CODEX_HOME = 'C:\\Profile Custom\\codex'
const MANAGED_CODEX_HOME = 'C:\\Orca Managed\\codex-runtime-home'

for (const shell of WINDOWS_POWERSHELLS) {
  describe.runIf(isAvailable(shell))(`${shell} managed home bootstrap`, () => {
    it.each(['FullLanguage', 'ConstrainedLanguage'] as const)(
      'restores CODEX_HOME in %s mode',
      (languageMode) => {
        expect(runBootstrap(shell, languageMode)).toContain(
          `mode=${languageMode};codexHome=${MANAGED_CODEX_HOME};orcaHome=${MANAGED_CODEX_HOME}`
        )
      }
    )
  })
}

function runBootstrap(
  shell: (typeof WINDOWS_POWERSHELLS)[number],
  languageMode: 'FullLanguage' | 'ConstrainedLanguage'
): string {
  return execFileSync(
    shell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', harness],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_HOME: PROFILE_CODEX_HOME,
        ORCA_CODEX_HOME: MANAGED_CODEX_HOME,
        ORCA_TEST_BOOTSTRAP: encodePowerShellCommand(getPowerShellOsc133Bootstrap()),
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
$runner.AddScript(
  '"mode=$($ExecutionContext.SessionState.LanguageMode);codexHome=$env:CODEX_HOME;orcaHome=$env:ORCA_CODEX_HOME"'
).Invoke()
$runner.Dispose()
$runspace.Dispose()
`)
