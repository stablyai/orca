import type { PortForwardEntry } from '../../../shared/remote-runtime/ssh/ssh-types'
import { assertPortNotShadowingListener } from '../../runtime/rpc/transports/websocket/shadowed-port-probe'
import { assertIpv6LoopbackPortFree } from './local-forward-ipv6-loopback-probe'

// Loopback answers at once on POSIX; Windows retries a refused SYN for seconds, which also means nothing listens.
const LOOPBACK_PROBE_TIMEOUT_MS = 150
// Keep the remote number when free, else the next few; past them, any free port beats a long scan.
const NEXT_PORT_ATTEMPTS = 20
const OS_PORT_ATTEMPTS = 5

/** Throws EADDRINUSE when a local server already answers on the port: a [::] or [::1] one would take
 *  a browser's localhost first, and macOS and Windows let a 127.0.0.1 bind shadow a 0.0.0.0 one. */
export async function assertLoopbackPortFree(port: number): Promise<void> {
  await Promise.all([
    assertIpv6LoopbackPortFree(port),
    assertPortNotShadowingListener('127.0.0.1', port, LOOPBACK_PROBE_TIMEOUT_MS)
  ])
}

async function loopbackPortAnswers(port: number): Promise<boolean> {
  return assertLoopbackPortFree(port).then(
    () => false,
    () => true
  )
}

/**
 * Starts a forward of `remotePort` on the same port number here when nothing answers on it, else the
 * next free one, else one the OS picks. `holdsIpv6Loopback` says whether the forward listens on [::1]
 * too; when it doesn't, an OS-picked port is checked there, since a browser tries [::1] first.
 */
export async function addForwardOnFreeLocalPort(
  remotePort: number,
  add: (localPort: number) => Promise<PortForwardEntry>,
  remove: (id: string) => Promise<unknown>,
  holdsIpv6Loopback: boolean
): Promise<PortForwardEntry> {
  const lastCandidate = Math.min(remotePort + NEXT_PORT_ATTEMPTS - 1, 65_535)
  for (let candidate = remotePort; candidate <= lastCandidate; candidate++) {
    if (await loopbackPortAnswers(candidate)) {
      continue
    }
    // Lost races and privileged ports move on to the next number.
    const entry = await add(candidate).catch(() => null)
    if (entry) {
      return entry
    }
  }
  return addOnFreeOsPort(add, remove, holdsIpv6Loopback)
}

/** The OS picks a port free on 127.0.0.1 only. Where the forward holds [::1] too, a collision there
 *  fails the start; where it doesn't, [::1] is probed. Either way, pick again. */
async function addOnFreeOsPort(
  add: (localPort: number) => Promise<PortForwardEntry>,
  remove: (id: string) => Promise<unknown>,
  holdsIpv6Loopback: boolean
): Promise<PortForwardEntry> {
  for (let attempt = 1; ; attempt++) {
    try {
      const entry = await add(0)
      if (!holdsIpv6Loopback) {
        await assertIpv6LoopbackPortFree(entry.localPort).catch(async (error: unknown) => {
          await remove(entry.id)
          throw error
        })
      }
      return entry
    } catch (error) {
      if (attempt >= OS_PORT_ATTEMPTS) {
        throw error
      }
    }
  }
}
