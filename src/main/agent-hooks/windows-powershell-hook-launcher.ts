// Why: centralizing the launcher keeps every installer on one command shape; #14815 and #16003 both turned on which shape it is.

// Why: an absolute forward-slash path avoids PATH hijacking and survives cmd.exe and Git Bash.
export function getWindowsSystem32Path(relativePath: string): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  return `${systemRoot.replaceAll('\\', '/')}/System32/${relativePath}`
}

export function getWindowsPowerShellExecutablePath(): string {
  return getWindowsSystem32Path('WindowsPowerShell/v1.0/powershell.exe')
}

/**
 * Switches for the PowerShell that relays hook output and exit status
 * (#14818 — conhost does neither).
 *
 * `-WindowStyle Hidden` stays. It is the shipped fix for #14815 and its four
 * duplicates (#14828, #15117, #15447, #15767): without it Windows allocates a
 * console per hook event, which steals foreground from whatever the user is
 * typing into, and strands a permanently visible window whenever a hook blocks
 * reading stdin (see hook-stdin-contract.ts). Those are reported, reproduced
 * user-facing failures on every hook event of every managed agent.
 *
 * `-ExecutionPolicy Bypass` is the flag that leaves the command line, because
 * it is the only one of the three with an exact in-payload equivalent (below):
 * it costs nothing to move. #16003 measured `-NoProfile -ExecutionPolicy Bypass
 * -WindowStyle Hidden -EncodedCommand` as denied at CreateProcess (exit 126,
 * Kaspersky Premium on Windows 11) no matter what the payload decodes to, so
 * the triple has to stop being spelled; dropping the policy flag breaks it.
 *
 * What is not established: that the remaining pair clears that AV signature —
 * the reporter measured no two-flag encoded shape. If it turns out not to, the
 * answer is another launcher shape that still suppresses the window, not
 * trading a reproduced regression for an unmeasured hope.
 */
export const WINDOWS_POWERSHELL_HOOK_SWITCHES = '-NoProfile -WindowStyle Hidden'

// Why: redirected PowerShell progress becomes CLIXML that can corrupt merged JSON
// output. It must be the FIRST statement: Set-ExecutionPolicy autoloads
// Microsoft.PowerShell.Security, whose "Preparing modules for first use."
// progress record is emitted before any later assignment can suppress it.
// Measured on Windows 11: bypass-first put 616 bytes of <Objs Version="1.1.0.1">
// on stderr and made "#< CLIXML" the first merged line; silencer-first, 0 bytes.
const HOOK_PROGRESS_SILENCER = "$ProgressPreference='SilentlyContinue'; "

/**
 * Process-scope stand-in for the `-ExecutionPolicy Bypass` switch (#16003).
 *
 * Equivalent by construction: the switch sets the Process scope too, and both
 * lose to a Group Policy scope. `-EncodedCommand` itself is never policy-gated,
 * so this always gets to run; it is what lets the managed `.ps1` hooks (Copilot)
 * execute under a Restricted or AllSigned machine policy.
 *
 * try/catch as well as `-ErrorAction SilentlyContinue`: under a MachinePolicy or
 * UserPolicy GPO the cmdlet reports that the process scope did not take, and
 * `-ErrorAction` only governs the non-terminating half of that. The switch this
 * replaces printed nothing at all in the same situation, and an ErrorRecord on
 * stderr is a live corruption risk for the consumers that merge our streams into
 * JSON stdout (see the progress silencer above). A hook must still answer its
 * agent when the policy is locked down.
 */
const HOOK_EXECUTION_POLICY_BYPASS =
  'try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction SilentlyContinue } catch {}; '

// Why: encoding shields paths and switches from cmd.exe and MSYS rewriting (#6078, #14815).
export function encodeWindowsPowerShellHookCommand(command: string): string {
  return Buffer.from(
    `${HOOK_PROGRESS_SILENCER}${HOOK_EXECUTION_POLICY_BYPASS}${command}`,
    'utf16le'
  ).toString('base64')
}

export function wrapWindowsPowerShellEncodedCommand(command: string): string {
  return `${getWindowsPowerShellExecutablePath()} ${WINDOWS_POWERSHELL_HOOK_SWITCHES} -EncodedCommand ${encodeWindowsPowerShellHookCommand(command)}`
}
