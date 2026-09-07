import { describe, expect, it } from 'vitest'
import {
  encodeWindowsPowerShellHookCommand,
  getWindowsPowerShellExecutablePath,
  needsHookExecutionPolicyBypass,
  WINDOWS_POWERSHELL_HOOK_SWITCHES,
  wrapWindowsPowerShellEncodedCommand
} from './windows-powershell-hook-launcher'

function decodePayload(command: string): string {
  const encoded = command.match(/ -EncodedCommand (\S+)$/)?.[1]
  expect(encoded).toBeTruthy()
  return Buffer.from(encoded!, 'base64').toString('utf16le')
}

/*
 * #16003 — endpoint security (Kaspersky, Windows 11) denies process creation
 * for the encoded launcher shape whatever the payload decodes to, and no
 * exclusion re-enabled it. Measured on the reporting host: the denied shape
 * exits 126 with or without the policy switch and with or without `-NoProfile`,
 * while `-NoProfile -EncodedCommand` alone runs 5/5. So the command line spells
 * neither the policy bypass (moved into the payload by #16576) nor the denied
 * window switch.
 *
 * The counter-pressure is real and is NOT resolved by these assertions:
 * #14815 (+ #14828, #15117, #15447, #15767) reported consoles taking
 * foreground. The previous suppression switch was that fix, but its behavior
 * was never measured — see the launcher's comment. These tests pin the shape
 * so it cannot be restored silently; whether a console appears is a question
 * for a live window measurement, which no unit test here can answer.
 */
describe('windows PowerShell hook launcher', () => {
  it('never spells a denied flag on the command line', () => {
    const command = wrapWindowsPowerShellEncodedCommand('exit 0')
    const switches = command.replace(/ -EncodedCommand \S+$/, '')

    expect(WINDOWS_POWERSHELL_HOOK_SWITCHES).not.toMatch(/-ExecutionPolicy/i)
    expect(switches).not.toMatch(/-ExecutionPolicy/i)
    // Why: measured exit 126 for the denied switch paired with -EncodedCommand.
    expect(WINDOWS_POWERSHELL_HOOK_SWITCHES).toBe('-NoProfile')
    expect(switches).toBe(`${getWindowsPowerShellExecutablePath()} -NoProfile`)
  })

  it('pins the exact launcher shape so a flag cannot come back unnoticed', () => {
    // Why this is worth a test: #16576 round 3 dropped a required launcher
    // invariant by accident and updated the tests to match, so nothing caught
    // it. Restoring either denied switch re-breaks every hook on an AV host.
    const command = wrapWindowsPowerShellEncodedCommand('exit 0')

    expect(WINDOWS_POWERSHELL_HOOK_SWITCHES).toBe('-NoProfile')
    expect(command).toMatch(/ -NoProfile -EncodedCommand [A-Za-z0-9+/=]+$/)
  })

  it('keeps the execution-policy bypass, in the payload where AV cannot read it', () => {
    // Why it must survive somewhere: Copilot's managed hook is a .ps1, which a
    // Restricted or AllSigned machine policy refuses to run without a bypass.
    // Process scope is exactly what the switch used to set.
    expect(
      decodePayload(wrapWindowsPowerShellEncodedCommand('exit 0', { executionPolicyBypass: true }))
    ).toContain(
      'Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction SilentlyContinue'
    )
  })

  it('swallows a terminating execution-policy failure, not just a non-terminating one', () => {
    // A GPO MachinePolicy/UserPolicy scope makes the cmdlet complain that the
    // process scope did not take. -ErrorAction covers only the non-terminating
    // half; the switch this replaced printed nothing either way, and an
    // ErrorRecord on stderr corrupts consumers that merge our streams into JSON.
    const decoded = decodePayload(
      wrapWindowsPowerShellEncodedCommand('exit 0', { executionPolicyBypass: true })
    )

    expect(decoded).toMatch(/try \{[^}]*Set-ExecutionPolicy[^}]*\} catch \{\}/)
  })

  it('applies the bypass before the caller command and keeps progress silenced', () => {
    const decoded = Buffer.from(
      encodeWindowsPowerShellHookCommand('& $scriptPath', { executionPolicyBypass: true }),
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
      encodeWindowsPowerShellHookCommand('& $scriptPath', { executionPolicyBypass: true }),
      'base64'
    ).toString('utf16le')

    expect(decoded.indexOf("$ProgressPreference='SilentlyContinue'")).toBeGreaterThanOrEqual(0)
    expect(decoded.indexOf("$ProgressPreference='SilentlyContinue'")).toBeLessThan(
      decoded.indexOf('Set-ExecutionPolicy')
    )
  })

  /*
   * HEADLINE INVARIANT. The launch shape was chosen by measurement on an AV host,
   * not by reasoning: #16003 measured that the denial happens at CreateProcess and
   * matches on the FLAG COMBINATION, independently of what the payload decodes to.
   * So the payload may change freely, and the command line may not.
   *
   * This is what stops a later "tidy-up" — folding `-NonInteractive` into the
   * switches constant is the tempting one (STA-6357 proposes exactly that) — from
   * silently re-opening a resolved AV defect. Any change to the shape needs a new
   * measurement on a Kaspersky host, not an argument that it ought to be fine.
   */
  it('keeps the launch shape byte-identical whichever payload it carries (AV-measured; re-measure before changing)', () => {
    const shapeOf = (command: string): string => command.replace(/ -EncodedCommand \S+$/, '')

    const withBypass = wrapWindowsPowerShellEncodedCommand('exit 0', {
      executionPolicyBypass: true
    })
    const withoutBypass = wrapWindowsPowerShellEncodedCommand('exit 0')

    expect(shapeOf(withBypass)).toBe(shapeOf(withoutBypass))
    expect(shapeOf(withoutBypass)).toBe(`${getWindowsPowerShellExecutablePath()} -NoProfile`)
    // The payloads must actually differ, or the assertion above proves nothing.
    expect(decodePayload(withBypass)).not.toBe(decodePayload(withoutBypass))
  })

  it('omits the execution-policy cmdlet for a payload that only runs a .cmd', () => {
    // Why it must go: on Windows PowerShell 5.1 the cmdlet takes a host
    // confirmation path even with -Force, and with stdin redirected that prompt
    // consumes the hook payload and echoes it to stdout (STA-6357). Execution
    // policy does not govern a batch file, so a .cmd payload gains nothing by it.
    const decoded = decodePayload(wrapWindowsPowerShellEncodedCommand('& $scriptPath'))

    expect(decoded).not.toContain('Set-ExecutionPolicy')
    // The progress silencer is unrelated to the policy bypass and must survive.
    expect(decoded).toBe("$ProgressPreference='SilentlyContinue'; & $scriptPath")
  })
})

describe('needsHookExecutionPolicyBypass', () => {
  it('asks for the bypass only for a .ps1, whatever its casing', () => {
    expect(
      needsHookExecutionPolicyBypass('C:\\Users\\me\\.orca\\agent-hooks\\copilot-hook.ps1')
    ).toBe(true)
    expect(
      needsHookExecutionPolicyBypass('C:\\Users\\me\\.orca\\agent-hooks\\COPILOT-HOOK.PS1')
    ).toBe(true)
  })

  it('does not ask for it for the .cmd every other managed hook ships', () => {
    for (const script of ['claude-hook.cmd', 'cursor-hook.cmd', 'gemini-hook.cmd']) {
      expect(needsHookExecutionPolicyBypass(`C:\\Users\\me\\.orca\\agent-hooks\\${script}`)).toBe(
        false
      )
    }
  })
})
