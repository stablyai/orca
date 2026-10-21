/** How the host census reaches a running Windows relay through its own bridge. */
import { commandWithNodePath } from '../ssh-remote-commands'
import type { RemoteHostPlatform } from '../ssh-remote-platform'
import { quotePowerShellLiteral as powerShellLiteral } from '../../../shared/powershell-native-argument'

export function windowsRelayConnectCommand(
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  remoteDir: string,
  sockPath: string,
  credentialFile: string
): string {
  return commandWithNodePath(
    hostPlatform,
    nodePath,
    remoteDir,
    `& ${powerShellLiteral(nodePath)} relay.js --connect --sock-path ${powerShellLiteral(sockPath)} --credential-file ${powerShellLiteral(credentialFile)}`
  )
}
