/** What to suggest when a server cannot be reached, chosen by the kind of host that owns it. */
import { withRemoteRuntimeTailscaleHint } from '../../../shared/remote-runtime-tailscale-hint'
import { classifyRuntimeEnvironmentHost } from '../../../shared/runtime-environment-host-kind'
import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'

const UNREACHABLE_RE =
  /could not connect to the remote orca runtime|remote orca runtime closed the connection|timed out (?:waiting for|while connecting to) the remote orca runtime/i

export function withRuntimeUnreachableHint(
  environment: Pick<KnownRuntimeEnvironment, 'orcadDeployment'>,
  message: string,
  endpoint: string | null | undefined
): string {
  const host = classifyRuntimeEnvironmentHost(environment)
  switch (host.kind) {
    case 'network':
      return withRemoteRuntimeTailscaleHint(message, endpoint)
    case 'wsl':
      // Why not Tailscale: a WSL host is a distro on this computer, reached over wsl.exe.
      return UNREACHABLE_RE.test(message)
        ? `${message} The Orca server in the WSL distro ${host.deployment.distro} isn’t answering; connect it again in Settings → Remote Orca Servers → WSL hosts.`
        : message
  }
}
