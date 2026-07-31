import { describe, expect, it } from 'vitest'
import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap
} from './powershell-osc133-bootstrap'

describe('PowerShell OSC 133 bootstrap', () => {
  it('wraps prompt/readline without bypassing profiles or execution policy', () => {
    const script = getPowerShellOsc133Bootstrap()

    expect(script).toContain('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()')
    expect(script).toContain('ORCA_OPENCODE_CONFIG_DIR')
    expect(script).toContain('ORCA_MIMOCODE_HOME')
    expect(script).not.toContain('ORCA_PI_CODING_AGENT_DIR')
    expect(script).not.toContain('ORCA_OMP_CODING_AGENT_DIR')
    expect(script).toContain('ORCA_OMP_STATUS_EXTENSION')
    expect(script).toContain('function Global:omp')
    expect(script).toContain('--extension $env:ORCA_OMP_STATUS_EXTENSION')
    expect(script).toContain('ORCA_CODEX_HOME')
    expect(script).toContain('function Global:prompt')
    expect(script).toContain('function Global:PSConsoleHostReadLine')
    expect(script).toContain('Esc = [char]27')
    expect(script).toContain('Bel = [char]7')
    expect(script).toContain(')]133;D;$fakeExitCode$(')
    expect(script).toContain(')]133;A$(')
    expect(script).toContain(')]133;B$(')
    expect(script).toContain(')]133;C$(')
    expect(script).not.toContain('`e]133')
    expect(script).not.toContain('$PROFILE')
    expect(script).not.toContain('ExecutionPolicy')
    expect(script).not.toContain('NoProfile')
  })

  it('isolates its early-return guards so they cannot abort the caller payload', () => {
    // Why: a top-level `return` ends the whole -EncodedCommand script, taking
    // the cwd restore and startup command callers append with it.
    const script = getPowerShellOsc133Bootstrap()

    expect(script.startsWith('. {\n')).toBe(true)
    expect(script.trimEnd().endsWith('}')).toBe(true)

    const blockStart = script.indexOf('. {')
    const languageModeGuard = script.indexOf(
      '$ExecutionContext.SessionState.LanguageMode -ne "FullLanguage"'
    )
    const reentryGuard = script.indexOf('Test-Path variable:global:__OrcaOsc133State')
    expect(languageModeGuard).toBeGreaterThan(blockStart)
    expect(reentryGuard).toBeGreaterThan(blockStart)

    // Balanced braces: an unclosed block would swallow whatever callers append.
    const depth = [...script].reduce(
      (acc, char) => acc + (char === '{' ? 1 : char === '}' ? -1 : 0),
      0
    )
    expect(depth).toBe(0)
  })

  it('encodes commands as UTF-16LE base64 for PowerShell -EncodedCommand', () => {
    expect(encodePowerShellCommand('Write-Output ok')).toBe(
      Buffer.from('Write-Output ok', 'utf16le').toString('base64')
    )
  })
})
