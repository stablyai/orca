import { orcadBunRuntimeFilename } from '../../shared/orcad-artifacts'
import {
  OrcadManagedStopCompletionSchema,
  OrcadManagedStopRequestSchema,
  type OrcadManagedStopRequest
} from '../../shared/orcad-managed-stop-request'
import { shellEscape } from './ssh-connection-utils'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

export function managedStopOrcadCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  request: OrcadManagedStopRequest,
  remoteHome: string
): string {
  const args = [
    joinRemotePath(host, remoteInstallDir, orcadBunRuntimeFilename(host.os)),
    joinRemotePath(host, remoteInstallDir, 'orcad.js'),
    '--complete-managed-stop',
    JSON.stringify(OrcadManagedStopRequestSchema.parse(request)),
    remoteHome
  ]
  return isWindowsRemoteHost(host)
    ? powerShellCommand(`& ${args.map(powerShellLiteral).join(' ')}; exit $LASTEXITCODE`)
    : args.map(shellEscape).join(' ')
}

export function parseManagedStopOrcadCompletion(
  output: string,
  expected: OrcadManagedStopRequest
): 'live' | 'unverifiable' | 'exited' {
  try {
    const response = OrcadManagedStopCompletionSchema.parse(JSON.parse(output.trim()))
    if (response.verdict === 'exited' && response.receiptPersisted !== true) {
      return 'unverifiable'
    }
    const receipt = OrcadManagedStopRequestSchema.parse(response)
    return JSON.stringify(receipt) === JSON.stringify(OrcadManagedStopRequestSchema.parse(expected))
      ? response.verdict
      : 'unverifiable'
  } catch {
    return 'unverifiable'
  }
}
