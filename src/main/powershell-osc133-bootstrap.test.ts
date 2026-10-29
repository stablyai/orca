import { describe, expect, it } from 'vitest'
import {
  encodePowerShellCommand,
  getPowerShellOsc133Bootstrap
} from './powershell-osc133-bootstrap'
import { getShellLaunchConfig } from './daemon/shell-ready'
import { resolveWindowsShellLaunchArgs } from './providers/windows-shell-args'
import { STARTUP_COMMAND_FEATURES } from './shell-startup-launch-intent-fixtures'

describe('PowerShell OSC 133 bootstrap', () => {
  // Bootstrap and startup commands share the EncodedCommand size limit: reasonable
  // commands ride in the shell args, and oversized ones fall back to barrier-queued
  // stdin delivery, which the pwsh startup barrier makes safe (#27293).
  it('leaves room for a realistic startup command to ride in the shell args', () => {
    const cwd = `C:\\Users\\alice\\${'nested-project-folder\\'.repeat(5)}repo`
    const result = resolveWindowsShellLaunchArgs(
      'pwsh.exe',
      cwd,
      cwd,
      undefined,
      `orca ${'x'.repeat(500)}`
    )

    expect(result.startupCommandDeliveredInShellArgs).toBe(true)
  })

  it('lets an oversized startup command fall back to barrier-queued stdin', () => {
    const cwd = `C:\\Users\\alice\\${'nested-project-folder\\'.repeat(5)}repo`
    const result = resolveWindowsShellLaunchArgs(
      'pwsh.exe',
      cwd,
      cwd,
      undefined,
      // Exactly STARTUP_COMMAND_TEXT_MAX_CHARS (module-private, windows-shell-args): the
      // text gate passes, but bootstrap + command together exceed the encoded arg budget,
      // so argv carries the bootstrap only and the daemon queues the command on stdin
      // behind the pwsh startup barrier.
      `orca ${'x'.repeat(5995)}`
    )

    expect(result.startupCommandDeliveredInShellArgs).toBeUndefined()
    expect(result.shellArgs.slice(0, 2)).toEqual(['-NoLogo', '-NoExit'])
    // The oversized command contributes nothing to argv: the encoded arg is byte-identical
    // to a launch with no startup command at all, proving stdin (barrier-queued) delivery.
    const noCommand = resolveWindowsShellLaunchArgs('pwsh.exe', cwd, cwd, undefined, undefined)
    const encodedArg = result.shellArgs[result.shellArgs.indexOf('-EncodedCommand') + 1]
    const noCommandEncodedArg =
      noCommand.shellArgs[noCommand.shellArgs.indexOf('-EncodedCommand') + 1]
    expect(encodedArg).toBe(noCommandEncodedArg)
  })

  it('wraps prompt/readline without bypassing profiles or execution policy', () => {
    const script = getPowerShellOsc133Bootstrap()

    expect(script).toContain('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()')
    expect(script).toContain('ORCA_OPENCODE_CONFIG_DIR')
    expect(script).toContain('ORCA_MIMOCODE_CONFIG_DIR')
    expect(script).not.toContain('ORCA_PI_CODING_AGENT_DIR')
    expect(script).not.toContain('ORCA_OMP_CODING_AGENT_DIR')
    expect(script).toContain('ORCA_OMP_STATUS_EXTENSION')
    expect(script).toContain('function Global:omp')
    expect(script).toContain('--extension $env:ORCA_OMP_STATUS_EXTENSION')
    expect(script).toContain('ORCA_CODEX_HOME')
    expect(script).toContain('ORCA_CODEX_LAUNCH_PREFLIGHT')
    expect(script).toContain('function Global:codex')
    expect(script).not.toContain('$Global:__OrcaCodexExecutable')
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

    const codexHomeRestore = script.indexOf('if ($env:ORCA_CODEX_HOME)')
    expect(codexHomeRestore).toBeGreaterThan(-1)
    expect(codexHomeRestore).toBeLessThan(script.indexOf('Test-Path variable:global:'))
    expect(codexHomeRestore).toBeLessThan(script.indexOf('LanguageMode -eq "FullLanguage"'))
  })

  it('publishes the shell-ready marker from the first prompt when the ready feature rides the env', () => {
    const script = getPowerShellOsc133Bootstrap()

    // Why env-gated: Windows pwsh panes get the same bootstrap byte for byte and
    // never set the variable, so the emission is inert there.
    expect(script).toContain('777;orca-shell-ready')
    expect(script).toContain('$env:ORCA_SHELL_FEATURES -split')
    expect(script).toContain('Remove-Item Env:\\ORCA_SHELL_FEATURES')
    const promptAt = script.indexOf('function Global:prompt')
    const markerAt = script.indexOf('777;orca-shell-ready')
    const dGateAt = script.indexOf('HasSeenPrompt) {')
    expect(promptAt).toBeGreaterThan(-1)
    expect(markerAt).toBeGreaterThan(promptAt)
    // Why before the D gate: the marker must precede the first prompt's own
    // markers so the barrier releases before any command-marker bookkeeping.
    expect(markerAt).toBeLessThan(dGateAt)
  })

  it('encodes commands as UTF-16LE base64 for PowerShell -EncodedCommand', () => {
    expect(encodePowerShellCommand('Write-Output ok')).toBe(
      Buffer.from('Write-Output ok', 'utf16le').toString('base64')
    )
  })

  // Every launcher must deliver quotes, variables, and newlines byte for byte.
  describe.each([
    [
      'daemon shell-ready',
      () => getShellLaunchConfig('powershell.exe', STARTUP_COMMAND_FEATURES).args ?? []
    ],
    [
      'windows shell args',
      () => resolveWindowsShellLaunchArgs('pwsh.exe', 'C:\\repo', 'C:\\repo').shellArgs
    ]
  ])('%s PowerShell launch', (_name, getArgs) => {
    it('delivers the bootstrap unmangled', () => {
      const args = getArgs()
      const encodedIndex = args.indexOf('-EncodedCommand')

      expect(encodedIndex).toBeGreaterThanOrEqual(0)
      expect(args).not.toContain('-Command')
      expect(args).not.toContain('-ExecutionPolicy')

      const delivered = Buffer.from(args[encodedIndex + 1] ?? '', 'base64').toString('utf16le')

      expect(delivered.startsWith(getPowerShellOsc133Bootstrap())).toBe(true)
    })
  })
})
