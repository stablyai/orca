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
 * The command line spells no flag beyond `-NoProfile`, because AV denies the
 * combinations. #16003 measured, on the reporting Kaspersky host:
 *
 *   -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand  126
 *   -NoProfile -WindowStyle Hidden -EncodedCommand                          126
 *   -WindowStyle Hidden -EncodedCommand                                     126
 *   -NoProfile -EncodedCommand                                              0 (5/5)
 *   -NoProfile -ExecutionPolicy Bypass -Command                             0 (5/5)
 *
 * The denial is at CreateProcess and is independent of the payload: `exit 0` is
 * denied too, and bash reports it as `Permission denied`. So `-WindowStyle
 * Hidden` + `-EncodedCommand` is the pair that has to stop being spelled.
 * #16576 removed `-ExecutionPolicy Bypass` (kept in-payload below), which was
 * the one flag of the three NOT in the signature — hooks kept failing.
 *
 * `-WindowStyle Hidden` was the shipped fix for #14815 (+#14828, #15117,
 * #15447, #15767). Removing it is a real tradeoff and is recorded as such: its
 * suppression was never measured — #14825 confirmed it *visually*, #16576's
 * author stated it "remains unverified on a real box", and #15506's author
 * argued it cannot help a `.cmd` child that has no console to inherit. The
 * console is allocated by the parent chain, not by this command line.
 *
 * Do not restore the flag to fix a console report. That trades every hook on an
 * AV host for a flicker. The answer is to shorten the interpreter chain — the
 * shipped doctrine of #15520 and #15595 — or a launcher that owns no console.
 */
export const WINDOWS_POWERSHELL_HOOK_SWITCHES = '-NoProfile'

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
