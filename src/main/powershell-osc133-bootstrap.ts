import { getPowerShellOmpShellWrapper } from './pty/omp-shell-wrapper'
import { getPowerShellCodexShellLaunchPreflight } from './pty/codex-shell-launch-preflight'
export { encodePowerShellCommand } from '../shared/powershell-command-encoding'

/**
 * Why every PTY site delivers this payload as `-EncodedCommand` and keeps doing so.
 *
 * An MDE report named the base64 a contributing "suspicious PowerShell" signal and
 * pointed at VS Code as the counter-example. VS Code and its forks actually ship
 * `["-noexit","-command",'try { . "{0}\\...\\shellIntegration.ps1" } catch {}']` -- a
 * one-liner that dot-sources a *file*, not inline script. Dot-sourcing is
 * execution-policy gated; inline text is not. Measured on Windows 11:
 *
 *   policy        dot-source .ps1   -Command inline   -EncodedCommand
 *   Restricted    blocked           runs              runs
 *   AllSigned     blocked           runs              runs
 *   RemoteSigned  runs              runs              runs
 *
 * So VS Code's shape silently drops OSC 133 -- and with it foreground-process and
 * exit-code tracking -- on exactly the locked-down fleets MDE runs on; its `catch {}`
 * is that failure being swallowed.
 *
 * Inline `-Command` does carry this payload intact through node-pty/ConPTY (verified
 * on powershell.exe 5.1 and pwsh 7.6.5), so the switch is feasible; it is declined
 * because it costs more signal than it removes. No PTY site spells `-ExecutionPolicy
 * Bypass`, so base64 is the whole of what would go, and AMSI and script-block logging
 * decode it anyway -- nothing is hidden from MDE today. What would change is the
 * process command line, which would then carry `$ExecutionContext.SessionState.
 * LanguageMode`, a `function Global:prompt` override and `[char]27`-assembled control
 * sequences in clear text: higher-signal for command-line heuristics than an opaque
 * token with no `Bypass` beside it.
 *
 * The payload is also not static -- providers/windows-shell-args.ts appends the PTY
 * cwd and the queued startup command. #7978 had to move cmd.exe startup commands off
 * `/K` to stdin because node-pty's argv escaping mangled their quotes; PowerShell
 * never needed that workaround, because `-EncodedCommand` is quoting-proof.
 */
const POWERSHELL_OSC133_BOOTSTRAP = `# Orca OSC 133 shell integration for PowerShell.
# Profiles have already loaded normally by the time -EncodedCommand runs.
# Restore managed ownership before the shell-integration compatibility guard.
if ($env:ORCA_OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR = $env:ORCA_OPENCODE_CONFIG_DIR }
if ($env:ORCA_MIMOCODE_HOME) { $env:MIMOCODE_HOME = $env:ORCA_MIMOCODE_HOME }
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
${getPowerShellCodexShellLaunchPreflight()}

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
