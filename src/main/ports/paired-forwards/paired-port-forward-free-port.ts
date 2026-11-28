import type { PortForwardEntry } from '../../../shared/remote-runtime/ssh/ssh-types'
import type { SshPortForwardManager } from '../../ssh/port-forwarding/ssh-port-forward'
import { addForwardOnFreeLocalPort } from '../../ssh/port-forwarding/forward-local-port-choice'
import type { ForwardMapping } from '../../ssh/port-forwarding/saved-port-forward-list'
import { savedForwardLocalPorts } from './paired-port-forward-saved'
import { holdsIpv6Loopback } from './paired-port-forward-provider'
import type { PairedPortForwardTunnel } from './paired-port-forward-tunnel'

/** The forward on `preferred.localPort` when nothing here answers there, else the next free port. */
export function addPairedForwardOnFirstFreePort(
  manager: SshPortForwardManager<PairedPortForwardTunnel>,
  tunnel: PairedPortForwardTunnel,
  preferred: ForwardMapping & { label?: string },
  reserved: ReadonlySet<number> = savedForwardLocalPorts()
): Promise<PortForwardEntry> {
  return addForwardOnFreeLocalPort({
    remotePort: preferred.remotePort,
    preferredLocalPort: preferred.localPort,
    add: (localPort) =>
      manager.addForward(
        tunnel.environmentId,
        tunnel,
        localPort,
        preferred.remoteHost,
        preferred.remotePort,
        preferred.label
      ),
    remove: (id) => manager.removeForwardAndWait(id),
    holdsIpv6Loopback: holdsIpv6Loopback(process.platform),
    reservedLocalPorts: reserved
  })
}
