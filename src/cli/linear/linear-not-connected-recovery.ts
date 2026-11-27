import type { RemoteServerSelection } from '../hosts/remote-server-selection'
import { resolveInvokedCliCommand } from '../orchestration/recovery/runtime-compatibility'

/** The connect command for this platform's usual shell: PowerShell has no printf and reads env vars as $env:NAME. */
export function linearConnectCommand(serverFlag?: string): string {
  const pipe =
    process.platform === 'win32' ? '$env:LINEAR_API_KEY |' : 'printf %s "$LINEAR_API_KEY" |'
  return `${pipe} ${resolveInvokedCliCommand()} linear connect${serverFlag ? ` ${serverFlag}` : ''}`
}

/** The runtime cannot know how this shell addressed it, so only the CLI can name the server and the exact connect command. */
export function linearNotConnectedRecovery(
  server: RemoteServerSelection | undefined
): { nextSteps: string[] } | undefined {
  if (!server) {
    return undefined
  }
  return {
    nextSteps: [
      `This command ran on the paired Orca server selected by ${server.label}, which keeps its own Linear connection. Connect it there: ${linearConnectCommand(server.flag)}`
    ]
  }
}
