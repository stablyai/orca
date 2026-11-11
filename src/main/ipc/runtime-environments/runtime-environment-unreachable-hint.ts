import { withRemoteRuntimeTailscaleHint } from '../../../shared/remote-runtime/remote-runtime-tailscale-hint'
import { classifyRuntimeEnvironmentHost } from '../../../shared/remote-runtime/host-catalog/runtime-environment-host-kind'
import type { KnownRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { isOrcaCloudRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/orca-cloud-environment-name'

const UNREACHABLE_RE =
  /could not connect to the remote orca runtime|remote orca runtime closed the connection|timed out (?:waiting for|while connecting to) the remote orca runtime/i

export function withRuntimeUnreachableHint(
  environment: Pick<KnownRuntimeEnvironment, 'orcadDeployment' | 'sshAccess'> &
    Partial<Pick<KnownRuntimeEnvironment, 'name' | 'source'>>,
  message: string,
  endpoint: string | null | undefined
): string {
  // Orca Cloud sandboxes are reached through Orca Cloud, not the user's network: one that does not
  // answer is asleep, gone, or another team's, and a Tailscale hint sends the user the wrong way.
  if (isOrcaCloudRuntimeEnvironment(environment)) {
    return message
  }
  const host = classifyRuntimeEnvironmentHost(environment)
  switch (host.kind) {
    case 'network':
      return withRemoteRuntimeTailscaleHint(message, endpoint)
    case 'ssh':
      // An SSH tunnel already crosses networks; Tailscale cannot help it.
      return message
    case 'wsl':
      // WSL is reached locally through wsl.exe; a Tailscale hint cannot help.
      return UNREACHABLE_RE.test(message)
        ? `${message} The Orca server in the WSL distro ${host.deployment.distro} isn’t answering; connect it again in Settings → Remote Orca Servers → WSL hosts.`
        : message
  }
}
