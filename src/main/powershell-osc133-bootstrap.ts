import { getPowerShellOmpShellWrapper } from './pty/omp-shell-wrapper'
import { MANAGED_DATA_ACCOUNT_POWERSHELL_RESTORE } from '../shared/managed-data-account-shell'
import { getPowerShellAgentWrappers } from '../shared/powershell-agent-wrappers'
export { encodePowerShellCommand } from '../shared/powershell-command-encoding'

// Inline scripts work under Restricted/AllSigned policies that block dot-sourced files.
// EncodedCommand preserves quoting for appended cwd/startup commands; AMSI and script logging still decode it.
const POWERSHELL_OSC133_BOOTSTRAP = `# Orca OSC 133 shell integration for PowerShell.
# Profiles have already loaded normally by the time -EncodedCommand runs.
# Restore managed ownership before the shell-integration compatibility guard.
if ($env:ORCA_OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR = $env:ORCA_OPENCODE_CONFIG_DIR }
${MANAGED_DATA_ACCOUNT_POWERSHELL_RESTORE}
if ($env:ORCA_MIMOCODE_CONFIG_DIR) { $env:MIMOCODE_CONFIG_DIR = $env:ORCA_MIMOCODE_CONFIG_DIR }
if ($env:ORCA_CODEX_HOME) { $env:CODEX_HOME = $env:ORCA_CODEX_HOME }

if ($ExecutionContext.SessionState.LanguageMode -eq "FullLanguage" -and
    ((-not (Test-Path variable:global:__OrcaOsc133State)) -or
     $null -eq $Global:__OrcaOsc133State.OriginalPrompt)) {
    # Wrap the user's final prompt/readline state; do not source profiles here.

    # Preserve Windows CJK output by keeping ConPTY on UTF-8 without bypassing
    # profile loading or execution-policy checks.
    try {
        [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
        [Console]::InputEncoding = [System.Text.UTF8Encoding]::new()
        $OutputEncoding = [Console]::OutputEncoding
    } catch { Write-Error $_ -ErrorAction Continue }

${getPowerShellOmpShellWrapper()}
${getPowerShellAgentWrappers()}

    $Global:__OrcaOsc133State = @{
        OriginalPrompt = $function:prompt
        OriginalReadLine = $function:PSConsoleHostReadLine
        HasSeenPrompt = $false
        HasPSReadLine = $null -ne (Get-Module -Name PSReadLine)
        Esc = [char]27
        Bel = [char]7
    }

    function Global:prompt {
        # Capture FIRST; any other expression can clobber PowerShell's success bit.
        $fakeExitCode = [int](!$global:?)
        Set-StrictMode -Off
        $result = ""

        # Emit D from prompt, not readline state. Some profile setups bypass
        # PSConsoleHostReadLine; the consumer only needs completion.
        if ($Global:__OrcaOsc133State.HasSeenPrompt) {
            $result += "$($Global:__OrcaOsc133State.Esc)]133;D;$fakeExitCode$($Global:__OrcaOsc133State.Bel)"
        }
        $Global:__OrcaOsc133State.HasSeenPrompt = $true

        $result += "$($Global:__OrcaOsc133State.Esc)]133;A$($Global:__OrcaOsc133State.Bel)"
        # Preserve the previous success/failure value for prompts that inspect it.
        if ($fakeExitCode -ne 0) { Write-Error "failure" -ea ignore }
        $result += $Global:__OrcaOsc133State.OriginalPrompt.Invoke()
        $result += "$($Global:__OrcaOsc133State.Esc)]133;B$($Global:__OrcaOsc133State.Bel)"
        $result
    }

    if ($Global:__OrcaOsc133State.HasPSReadLine -and
        $null -ne $Global:__OrcaOsc133State.OriginalReadLine) {
        function Global:PSConsoleHostReadLine {
            $commandLine = $Global:__OrcaOsc133State.OriginalReadLine.Invoke()
            [Console]::Write("$($Global:__OrcaOsc133State.Esc)]133;C$($Global:__OrcaOsc133State.Bel)")
            return $commandLine
        }
    }
}
`

// Strip source comments to leave command-line space for appended startup commands.
const POWERSHELL_OSC133_BOOTSTRAP_PAYLOAD = POWERSHELL_OSC133_BOOTSTRAP.replace(
  /^[ \t]*#.*\n/gm,
  ''
)

export function getPowerShellOsc133Bootstrap(): string {
  return POWERSHELL_OSC133_BOOTSTRAP_PAYLOAD
}

export function isPowerShellExecutableName(shellName: string): boolean {
  const normalized = shellName.toLowerCase()
  return (
    normalized === 'pwsh' ||
    normalized === 'pwsh.exe' ||
    normalized === 'powershell' ||
    normalized === 'powershell.exe'
  )
}
