import { getPowerShellOmpShellWrapper } from './pty/omp-shell-wrapper'
export { encodePowerShellCommand } from '../shared/powershell-command-encoding'

const POWERSHELL_OSC133_BOOTSTRAP = `# Orca OSC 133 shell integration for PowerShell.
if ((Test-Path variable:global:__OrcaOsc133State) -and
    $null -ne $Global:__OrcaOsc133State.OriginalPrompt) {
    return
}

if ($ExecutionContext.SessionState.LanguageMode -ne "FullLanguage") {
    return
}

# Profiles have already loaded normally by the time -EncodedCommand runs.
# Wrap the user's final prompt/readline state; do not source profiles here.

# Preserve Windows CJK output by keeping ConPTY on UTF-8 without bypassing
# profile loading or execution-policy checks.
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new()
    $OutputEncoding = [Console]::OutputEncoding
} catch { Write-Error $_ -ErrorAction Continue }

# Profiles can re-export user defaults after Orca's spawn env is set.
if ($env:ORCA_OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR = $env:ORCA_OPENCODE_CONFIG_DIR }
${getPowerShellOmpShellWrapper()}
if ($env:ORCA_CODEX_HOME) { $env:CODEX_HOME = $env:ORCA_CODEX_HOME }
if ($env:ORCA_CODEX_HOME) {
    # Why: Codex composer recall reads CODEX_HOME/history.jsonl globally.
    # Orca resume should rely on replayed session prompts, not unrelated sessions.
    function Global:codex {
        $env:CODEX_HOME = $env:ORCA_CODEX_HOME
        $codexCommand = Get-Command codex -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $codexCommand) {
            throw "codex executable not found"
        }
        $codexArgs = [System.Collections.Generic.List[string]]::new()
        $codexInserted = $false
        foreach ($arg in $args) {
            if (-not $codexInserted -and $arg -eq '--') {
                [void]$codexArgs.Add('-c')
                [void]$codexArgs.Add('history.persistence="none"')
                $codexInserted = $true
            }
            [void]$codexArgs.Add($arg)
        }
        if (-not $codexInserted) {
            [void]$codexArgs.Add('-c')
            [void]$codexArgs.Add('history.persistence="none"')
        }
        & $codexCommand.Source @($codexArgs.ToArray())
    }
}

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
