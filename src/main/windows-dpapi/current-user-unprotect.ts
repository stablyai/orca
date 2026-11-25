import { runProcess } from '@orca/process-host'
import { windowsPowerShellPath } from '@orca/process-host/windows-system-binary'

const UNPROTECT_SCRIPT = [
  'try { Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop }',
  'catch { try { Add-Type -AssemblyName System.Security -ErrorAction Stop } catch {} };',
  '$in=[Convert]::FromBase64String([Console]::In.ReadLine());',
  '$out=[System.Security.Cryptography.ProtectedData]::Unprotect($in,$null,',
  '[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
  '[Convert]::ToBase64String($out)'
].join('')

/**
 * Decrypts a current-user DPAPI blob (no entropy) given as single-line base64. Resolves null when
 * DPAPI refuses it; rejects when PowerShell could not start or finish, so callers can retry.
 */
export async function unprotectWindowsDpapiCurrentUser(blobBase64: string): Promise<Buffer | null> {
  // Ciphertext and plaintext travel over stdin/stdout, never argv; the system path avoids Electron's PATH.
  const result = await runProcess({
    program: windowsPowerShellPath(),
    args: ['-NoProfile', '-NonInteractive', '-Command', UNPROTECT_SCRIPT],
    timeoutMs: 10_000,
    input: blobBase64
  })
  if (result.timedOut || result.code === null) {
    throw new Error('PowerShell DPAPI decryption did not finish')
  }
  return result.code === 0 ? Buffer.from(result.stdout.trim(), 'base64') : null
}
