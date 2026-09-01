import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type AntigravityCredentials = {
  accessToken: string
  refreshToken: string | null
}

export type AntigravityCredentialsReadResult =
  | { status: 'unsupported' }
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; credentials: AntigravityCredentials }

// Why: current Windows installs store OAuth JSON under this Credential Manager target.
export function parseAntigravityCredentialBlob(text: string): AntigravityCredentials | null {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof json !== 'object' || json === null) {
    return null
  }
  const token = (json as { token?: unknown }).token
  if (typeof token !== 'object' || token === null) {
    return null
  }
  const accessToken = (token as { access_token?: unknown }).access_token
  const refreshToken = (token as { refresh_token?: unknown }).refresh_token
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return null
  }
  return {
    accessToken,
    refreshToken: typeof refreshToken === 'string' && refreshToken.length > 0 ? refreshToken : null
  }
}

function buildCredReadPowerShell(): string {
  // Why: CredReadW is the only API that returns the secret blob; cmdkey cannot.
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public class OrcaAntigravityCred {',
    '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
    '  public struct CREDENTIAL {',
    '    public uint Flags; public uint Type; public IntPtr TargetName; public IntPtr Comment;',
    '    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;',
    '    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;',
    '    public uint AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;',
    '  }',
    '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    '  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);',
    '  [DllImport("advapi32.dll", SetLastError = true)]',
    '  public static extern void CredFree(IntPtr buffer);',
    '  public static string ReadGeneric(string target) {',
    '    IntPtr ptr;',
    '    if (!CredRead(target, 1, 0, out ptr) || ptr == IntPtr.Zero) return "";',
    '    try {',
    '      var cred = Marshal.PtrToStructure<CREDENTIAL>(ptr);',
    '      if (cred.CredentialBlob == IntPtr.Zero || cred.CredentialBlobSize == 0) return "";',
    '      byte[] bytes = new byte[cred.CredentialBlobSize];',
    '      Marshal.Copy(cred.CredentialBlob, bytes, 0, (int)cred.CredentialBlobSize);',
    '      return Encoding.UTF8.GetString(bytes);',
    '    } finally { CredFree(ptr); }',
    '  }',
    '}',
    '"@',
    "$blob = [OrcaAntigravityCred]::ReadGeneric('gemini:antigravity')",
    'if ([string]::IsNullOrEmpty($blob)) { exit 2 }',
    '[Console]::Out.Write($blob)'
  ].join('\n')
}

async function readWindowsCredentialBlob(signal?: AbortSignal): Promise<string | null> {
  const script = buildCredReadPowerShell()
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        encoding: 'utf-8',
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 2 * 1024 * 1024,
        signal
      }
    )
    const text = typeof stdout === 'string' ? stdout.trim() : ''
    return text.length > 0 ? text : null
  } catch (err) {
    if (signal?.aborted) {
      throw signal.reason
    }
    const code =
      err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined
    // exit 2 = no credential entry
    if (code === 2) {
      return null
    }
    throw err
  }
}

export async function readAntigravityCredentials(
  signal?: AbortSignal
): Promise<AntigravityCredentialsReadResult> {
  signal?.throwIfAborted()
  if (process.platform !== 'win32') {
    // Why: this credential target is Windows-specific; other stores need separate readers.
    return { status: 'unsupported' }
  }
  try {
    const blob = await readWindowsCredentialBlob(signal)
    signal?.throwIfAborted()
    if (!blob) {
      return { status: 'missing' }
    }
    const credentials = parseAntigravityCredentialBlob(blob)
    if (!credentials) {
      return { status: 'error', error: 'Antigravity credential blob is invalid' }
    }
    return { status: 'ok', credentials }
  } catch {
    if (signal?.aborted) {
      throw signal.reason
    }
    return { status: 'error', error: 'Unable to read Antigravity credentials' }
  }
}

export function hasAntigravityAuthConfigured(result: AntigravityCredentialsReadResult): boolean {
  return result.status === 'ok'
}
