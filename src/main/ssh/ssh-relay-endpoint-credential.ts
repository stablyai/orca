import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'

const POSIX_CREDENTIAL_SCRIPT =
  'const fs=require("fs"),crypto=require("crypto"),p=process.argv[1],' +
  't=p+"."+process.pid+"."+crypto.randomBytes(8).toString("hex")+".tmp";' +
  'try{' +
  'fs.writeFileSync(t,crypto.randomBytes(32).toString("base64url"),{flag:"wx",mode:0o600});' +
  'fs.renameSync(t,p)' +
  '}finally{try{fs.unlinkSync(t)}catch(e){if(e.code!=="ENOENT")throw e}}'

export function relayEndpointCredentialWriteCommand(
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  credentialFile: string
): string {
  if (!isWindowsRemoteHost(hostPlatform)) {
    return `${shellEscape(nodePath)} -e ${shellEscape(POSIX_CREDENTIAL_SCRIPT)} ${shellEscape(credentialFile)}`
  }
  return powerShellCommand(
    [
      '$ErrorActionPreference = "Stop"',
      `$path = ${powerShellLiteral(credentialFile)}`,
      '$tempPath = $path + "." + [Guid]::NewGuid().ToString("N") + ".tmp"',
      '$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
      '$security = [System.Security.AccessControl.FileSecurity]::new()',
      '$security.SetOwner($identity)',
      '$security.SetAccessRuleProtection($true,$false)',
      '$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow)',
      '$security.AddAccessRule($rule)',
      '$random = [byte[]]::new(32)',
      '$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()',
      'try { $rng.GetBytes($random) } finally { $rng.Dispose() }',
      '$credential = [Convert]::ToBase64String($random).TrimEnd("=").Replace("+","-").Replace("/","_")',
      '$data = [System.Text.UTF8Encoding]::new($false).GetBytes($credential)',
      '$stream = [System.IO.FileStream]::new($tempPath,[System.IO.FileMode]::CreateNew,[System.Security.AccessControl.FileSystemRights]::Write,[System.IO.FileShare]::None,4096,[System.IO.FileOptions]::WriteThrough,$security)',
      'try { $stream.Write($data,0,$data.Length) } finally { $stream.Dispose() }',
      'try { [System.IO.File]::Delete($path); [System.IO.File]::Move($tempPath,$path) } finally { [System.IO.File]::Delete($tempPath) }'
    ].join('; ')
  )
}

export async function writeRelayEndpointCredential(
  conn: SshConnection,
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  credentialFile: string,
  options?: { signal?: AbortSignal }
): Promise<void> {
  await execCommand(
    conn,
    relayEndpointCredentialWriteCommand(hostPlatform, nodePath, credentialFile),
    {
      wrapCommand: !isWindowsRemoteHost(hostPlatform),
      signal: options?.signal
    }
  )
}
