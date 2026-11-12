import { commandWithNodePath } from '../../remote-exec/ssh-remote-commands'
import type { RemoteHostPlatform } from '../../remote-host/ssh-remote-platform'
import { quotePowerShellLiteral as powerShellLiteral } from '../../../../shared/powershell-native-argument'

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
