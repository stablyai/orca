import { getPowerShellOmpShellWrapper } from './pty/omp-shell-wrapper'
import { getPowerShellCodexShellLaunchPreflight } from './pty/codex-shell-launch-preflight'
import {
  SHELL_COMMAND_MAX_CHARS,
  SHELL_COMMAND_NONCE_ENV,
  SHELL_INTEGRATION_CONTEXT_ENV,
  SHELL_INTEGRATION_DIRECT_CONTEXT
} from './shell-command-marker-template'
export { encodePowerShellCommand } from '../shared/powershell-command-encoding'

const POWERSHELL_OSC133_BOOTSTRAP = `# Orca OSC 133 shell integration for PowerShell.
# Profiles have already loaded normally by the time -EncodedCommand runs.
# Restore managed ownership before the shell-integration compatibility guard.
if ($env:ORCA_OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR = $env:ORCA_OPENCODE_CONFIG_DIR }
if ($env:ORCA_MIMOCODE_HOME) { $env:MIMOCODE_HOME = $env:ORCA_MIMOCODE_HOME }
if ($env:ORCA_CODEX_HOME) { $env:CODEX_HOME = $env:ORCA_CODEX_HOME }
$__orcaCommandNonce = [Environment]::GetEnvironmentVariable('${SHELL_COMMAND_NONCE_ENV}')
$__orcaIntegrationContext = [Environment]::GetEnvironmentVariable('${SHELL_INTEGRATION_CONTEXT_ENV}')
[Environment]::SetEnvironmentVariable('${SHELL_COMMAND_NONCE_ENV}', $null)
[Environment]::SetEnvironmentVariable('${SHELL_INTEGRATION_CONTEXT_ENV}', $null)

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
${getPowerShellCodexShellLaunchPreflight()}

    $Global:__OrcaOsc133State = @{
        OriginalPrompt = $function:prompt
        OriginalReadLine = $function:PSConsoleHostReadLine
        HasSeenPrompt = $false
        HasPSReadLine = $null -ne (Get-Module -Name PSReadLine)
        Esc = [char]27
        Bel = [char]7
        CommandNonce = $__orcaCommandNonce
        # Why the context test gates both arms: it is the same signal the PTY
        # authority uses to install its scanner. Without it a pane whose markers
        # Orca disabled would still paint raw orca-cmd rows. The nonce cannot be
        # the gate here — Windows 10 emits untrusted rows with no nonce.
        CommandMarkersAllowed = -not [string]::IsNullOrEmpty($__orcaIntegrationContext) -and
            ($__orcaIntegrationContext -eq '${SHELL_INTEGRATION_DIRECT_CONTEXT}' -or
            (-not $env:TMUX -and -not $env:STY -and $env:TERM -notmatch '^(tmux|screen)'))
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
            if ($Global:__OrcaOsc133State.CommandMarkersAllowed) {
                $boundedCommandLine = [string]$commandLine
                if ($boundedCommandLine.Length -gt ${SHELL_COMMAND_MAX_CHARS}) {
                    $boundedCommandLine = $boundedCommandLine.Substring(0, ${SHELL_COMMAND_MAX_CHARS})
                }
                $encodedCommandLine = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($boundedCommandLine))
                [Console]::Write("$($Global:__OrcaOsc133State.Esc)]777;orca-cmd;$($Global:__OrcaOsc133State.CommandNonce);$encodedCommandLine$($Global:__OrcaOsc133State.Bel)")
            }
            [Console]::Write("$($Global:__OrcaOsc133State.Esc)]133;C$($Global:__OrcaOsc133State.Bel)")
            return $commandLine
        }
    }
}
Remove-Variable __orcaCommandNonce, __orcaIntegrationContext -ErrorAction SilentlyContinue
`

export function getPowerShellOsc133Bootstrap(): string {
  return POWERSHELL_OSC133_BOOTSTRAP
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
