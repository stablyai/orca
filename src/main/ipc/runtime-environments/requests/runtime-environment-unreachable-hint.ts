import { withRemoteRuntimeTailscaleHint } from '../../../../shared/remote-runtime/remote-runtime-tailscale-hint'
import { classifyRuntimeEnvironmentHost } from '../../../../shared/remote-runtime/host-catalog/runtime-environment-host-kind'
import type { KnownRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'

const UNREACHABLE_RE =
  /could not connect to the remote orca runtime|remote orca runtime closed the connection|timed out (?:waiting for|while connecting to) the remote orca runtime/i

export function withRuntimeUnreachableHint(
  environment: Pick<KnownRuntimeEnvironment, 'name' | 'orcadDeployment' | 'sshAccess'>,
  message: string,
  endpoint: string | null | undefined
): string {
  if (!UNREACHABLE_RE.test(message)) {
    return message
  }
  const hostHint = `${environment.name} isn't answering; make sure Orca is running and connected on that host, then check the command outcome before retrying.`
  if (message.includes(hostHint)) {
    return message
  }
  const messageWithHostHint = `${message} ${hostHint}`
  const host = classifyRuntimeEnvironmentHost(environment)
  switch (host.kind) {
    case 'network':
      return withRemoteRuntimeTailscaleHint(messageWithHostHint, endpoint)
    case 'ssh':
      // An SSH tunnel already crosses networks; Tailscale cannot help it.
      return messageWithHostHint
    case 'wsl':
      // WSL is reached locally through wsl.exe; a Tailscale hint cannot help.
      return `${messageWithHostHint} The Orca server in the WSL distro ${host.deployment.distro} needs reconnecting in Settings → Remote Orca Servers → WSL hosts.`
  }
}
