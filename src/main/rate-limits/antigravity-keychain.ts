import { execFile } from 'node:child_process'
import { encodePowerShellCommand } from '../../shared/powershell-command-encoding'

const KEYCHAIN_SERVICE = 'gemini'
const KEYCHAIN_ACCOUNT = 'antigravity'
const KEYCHAIN_COMMAND_TIMEOUT_MS = 3_000
const KEYCHAIN_MAX_BUFFER = 128 * 1024

export type AntigravityKeyringReadResult =
  | { status: 'found'; value: string }
  | { status: 'missing' }
  | { status: 'unavailable' }

type CommandOptions = {
  input?: string
  signal?: AbortSignal
}

type CommandResult = {
  stdout: string
  stderr: string
}

// Why: Antigravity uses the Go keyring service/account pair, not Orca's own
// Electron safeStorage namespace. Keep this adapter narrow so other auth files
// cannot accidentally become credential authorities for this provider.
export async function readAntigravityKeyring(
  signal?: AbortSignal
): Promise<AntigravityKeyringReadResult> {
  if (process.platform === 'darwin') {
    return readMacKeychain(signal)
  }
  if (process.platform === 'linux') {
    return readLinuxSecretService(signal)
  }
  if (process.platform === 'win32') {
    return readWindowsCredentialManager(signal)
  }
  return { status: 'unavailable' }
}

export async function writeAntigravityKeyring(value: string, signal?: AbortSignal): Promise<void> {
  if (process.platform === 'darwin') {
    await runCommand(
      'security',
      ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w', value],
      { signal }
    )
    return
  }
  if (process.platform === 'linux') {
    await runCommand(
      'secret-tool',
      [
        'store',
        '--label=Antigravity OAuth token',
        'service',
        KEYCHAIN_SERVICE,
        'account',
        KEYCHAIN_ACCOUNT
      ],
      { input: value, signal }
    )
    return
  }
  if (process.platform === 'win32') {
    await runCommand(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        encodePowerShellCommand(WINDOWS_CREDENTIAL_WRITE_SCRIPT)
      ],
      { input: value, signal }
    )
    return
  }
  throw new Error('System keyring is unavailable on this platform')
}

async function readMacKeychain(signal?: AbortSignal): Promise<AntigravityKeyringReadResult> {
  try {
    const { stdout } = await runCommand(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
      { signal }
    )
    return stdout.trim() ? { status: 'found', value: stdout.trim() } : { status: 'missing' }
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    if (isNotFoundError(error)) {
      return { status: 'missing' }
    }
    return { status: 'unavailable' }
  }
}

async function readLinuxSecretService(signal?: AbortSignal): Promise<AntigravityKeyringReadResult> {
  try {
    const { stdout } = await runCommand(
      'secret-tool',
      ['lookup', 'service', KEYCHAIN_SERVICE, 'account', KEYCHAIN_ACCOUNT],
      { signal }
    )
    return stdout.trim() ? { status: 'found', value: stdout.trim() } : { status: 'missing' }
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    if (isCommandMissingError(error) || isNotFoundError(error)) {
      return { status: 'unavailable' }
    }
    return { status: 'missing' }
  }
}

async function readWindowsCredentialManager(
  signal?: AbortSignal
): Promise<AntigravityKeyringReadResult> {
  try {
    const { stdout } = await runCommand(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        encodePowerShellCommand(WINDOWS_CREDENTIAL_READ_SCRIPT)
      ],
      { signal }
    )
    return stdout.trim() ? { status: 'found', value: stdout.trim() } : { status: 'missing' }
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    return isCommandMissingError(error) ? { status: 'unavailable' } : { status: 'missing' }
  }
}

function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    let child: ReturnType<typeof execFile> | undefined
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      child?.kill()
      reject(Object.assign(new Error('System keyring command timed out'), { code: 'ETIMEDOUT' }))
    }, KEYCHAIN_COMMAND_TIMEOUT_MS)

    const finish = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      callback()
    }

    const abort = (): void => {
      child?.kill()
      finish(() =>
        reject(Object.assign(new Error('System keyring command aborted'), { name: 'AbortError' }))
      )
    }

    if (options.signal?.aborted) {
      abort()
      return
    }
    options.signal?.addEventListener('abort', abort, { once: true })

    try {
      child = execFile(
        command,
        args,
        {
          encoding: 'utf8',
          maxBuffer: KEYCHAIN_MAX_BUFFER,
          timeout: KEYCHAIN_COMMAND_TIMEOUT_MS,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          if (error) {
            finish(() =>
              reject(
                Object.assign(error, {
                  stdout: String(stdout),
                  stderr: String(stderr)
                })
              )
            )
            return
          }
          finish(() => resolve({ stdout: String(stdout), stderr: String(stderr) }))
        }
      )
      if (options.input !== undefined && child.stdin) {
        child.stdin.end(options.input)
      }
    } catch (error) {
      finish(() => reject(error))
    }
  })
}

function isCommandMissingError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function isNotFoundError(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
  const message =
    error && typeof error === 'object'
      ? `${(error as { stderr?: unknown }).stderr ?? ''} ${(error as { message?: unknown }).message ?? ''}`
      : String(error)
  return code === 44 || /could not be found|not found/i.test(message)
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'name' in error && error.name === 'AbortError'
  )
}

const WINDOWS_CREDENTIAL_LIBRARY = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OrcaAntigravityCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWrite(ref CREDENTIAL credential, uint flags);
  public static string Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, 1, 0, out pointer)) return null;
    try {
      CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
      if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0) return null;
      byte[] bytes = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, bytes, 0, (int)credential.CredentialBlobSize);
      return Encoding.UTF8.GetString(bytes);
    } finally {
      CredFree(pointer);
    }
  }
  public static bool Write(string target, string value) {
    byte[] bytes = Encoding.UTF8.GetBytes(value);
    IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, blob, bytes.Length);
      CREDENTIAL credential = new CREDENTIAL {
        Type = 1,
        TargetName = target,
        CredentialBlobSize = (uint)bytes.Length,
        CredentialBlob = blob,
        Persist = 2,
        UserName = target
      };
      return CredWrite(ref credential, 0);
    } finally {
      Marshal.FreeHGlobal(blob);
    }
  }
}
'@
`

const WINDOWS_CREDENTIAL_READ_SCRIPT = `${WINDOWS_CREDENTIAL_LIBRARY}
$target = 'gemini:antigravity'
$value = [OrcaAntigravityCredential]::Read($target)
if ($null -eq $value) { $value = [OrcaAntigravityCredential]::Read('gemini/antigravity') }
if ($null -ne $value) {
  [Console]::Out.Write($value)
}
`

const WINDOWS_CREDENTIAL_WRITE_SCRIPT = `${WINDOWS_CREDENTIAL_LIBRARY}
$inputValue = [Console]::In.ReadToEnd()
if ($inputValue.Length -eq 0 -or -not [OrcaAntigravityCredential]::Write('gemini:antigravity', $inputValue)) {
  exit 1
}
`
