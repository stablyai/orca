import { describe, expect, it } from 'vitest'
import {
  encodeWindowsPowerShellHookCommand,
  WINDOWS_POWERSHELL_HOOK_SWITCHES,
  wrapWindowsPowerShellEncodedCommand
} from './windows-powershell-hook-launcher'

function decodePayload(command: string): string {
  const encoded = command.match(/ -EncodedCommand (\S+)$/)?.[1]
  expect(encoded).toBeTruthy()
  return Buffer.from(encoded!, 'base64').toString('utf16le')
}

/*
 * Two reproduced Windows failures constrain this one string, in opposite
 * directions:
 *
 * #16003 — endpoint security (Kaspersky Premium, Windows 11) denies process
 * creation for `-ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand`
 * whatever the payload decodes to, and no exclusion re-enabled it. The triple
 * must stop being spelled.
 *
 * #14815 (+ #14828, #15117, #15447, #15767) — without `-WindowStyle Hidden`
 * every hook event allocates a console that takes foreground and eats the
 * user's keystrokes, and strands a visible window outright when the hook blocks
 * on stdin. Window suppression must stay.
 *
 * Both hold only if the flag that leaves the command line is the policy bypass,
 * which is the one with an exact in-payload equivalent.
 */
describe('windows PowerShell hook launcher', () => {
  it('never spells the denied flag triple on the command line', () => {
    const command = wrapWindowsPowerShellEncodedCommand('exit 0')

    expect(WINDOWS_POWERSHELL_HOOK_SWITCHES).not.toMatch(/-ExecutionPolicy/i)
    expect(command.replace(/ -EncodedCommand \S+$/, '')).not.toMatch(/-ExecutionPolicy/i)
  })

  it('keeps hiding the console window on every hook event (#14815)', () => {
    // Dropping this flag is not a cosmetic flash: the console takes foreground
    // and swallows what the user is typing into Orca (#14828), and never closes
    // at all when the hook blocks reading stdin (#14815).
    const command = wrapWindowsPowerShellEncodedCommand('exit 0')

    expect(WINDOWS_POWERSHELL_HOOK_SWITCHES).toBe('-NoProfile -WindowStyle Hidden')
    expect(command).toMatch(/ -NoProfile -WindowStyle Hidden -EncodedCommand [A-Za-z0-9+/=]+$/)
  })

  it('keeps the execution-policy bypass, in the payload where AV cannot read it', () => {
    // Why it must survive somewhere: Copilot's managed hook is a .ps1, which a
    // Restricted or AllSigned machine policy refuses to run without a bypass.
    // Process scope is exactly what the switch used to set.
    expect(decodePayload(wrapWindowsPowerShellEncodedCommand('exit 0'))).toContain(
      'Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction SilentlyContinue'
    )
  })

  it('swallows a terminating execution-policy failure, not just a non-terminating one', () => {
    // A GPO MachinePolicy/UserPolicy scope makes the cmdlet complain that the
    // process scope did not take. -ErrorAction covers only the non-terminating
    // half; the switch this replaced printed nothing either way, and an
    // ErrorRecord on stderr corrupts consumers that merge our streams into JSON.
    const decoded = decodePayload(wrapWindowsPowerShellEncodedCommand('exit 0'))

    expect(decoded).toMatch(/try \{[^}]*Set-ExecutionPolicy[^}]*\} catch \{\}/)
  })

  it('applies the bypass before the caller command and keeps progress silenced', () => {
    const decoded = Buffer.from(
      encodeWindowsPowerShellHookCommand('& $scriptPath'),
      'base64'
    ).toString('utf16le')

    expect(decoded).toBe(
      "$ProgressPreference='SilentlyContinue'; try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction SilentlyContinue } catch {}; & $scriptPath"
    )
  })

  it('silences progress before anything that can autoload a module', () => {
    // Set-ExecutionPolicy pulls in Microsoft.PowerShell.Security, and its
    // "Preparing modules for first use." progress record is written before a
    // later assignment can suppress it. Measured on Windows 11: bypass-first put
    // 616 bytes of <Objs Version="1.1.0.1"> on stderr and made "#< CLIXML" the
    // first merged line -- the exact corruption HOOK_PROGRESS_SILENCER exists to
    // stop. Silencer-first measured 0 bytes.
    const decoded = Buffer.from(
      encodeWindowsPowerShellHookCommand('& $scriptPath'),
      'base64'
    ).toString('utf16le')

    expect(decoded.indexOf("$ProgressPreference='SilentlyContinue'")).toBeGreaterThanOrEqual(0)
    expect(decoded.indexOf("$ProgressPreference='SilentlyContinue'")).toBeLessThan(
      decoded.indexOf('Set-ExecutionPolicy')
    )
  })
})
