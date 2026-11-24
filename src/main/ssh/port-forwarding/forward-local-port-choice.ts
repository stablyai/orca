import type { PortForwardEntry } from '../../../shared/remote-runtime/ssh/ssh-types'
import { assertPortNotShadowingListener } from '../../runtime/rpc/transports/websocket/shadowed-port-probe'
import { assertIpv6LoopbackPortFree } from './local-forward-ipv6-loopback-probe'
import { serializePortForwardChange } from '../../ipc/ssh/ssh-managed-port-forward-restore'

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

const LISTENER_POLL_MS = 100

/** Resolves once something accepts connections on 127.0.0.1:`port`; throws after `timeoutMs` or once
 *  the forward closes. A system SSH forward reports started before OpenSSH has logged in and bound. */
async function waitForLoopbackListener(
  port: number,
  timeoutMs: number,
  isOpen: () => boolean
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!isOpen()) {
      throw new Error(`Port forward on 127.0.0.1:${port} closed while starting`)
    }
    const answered = await assertPortNotShadowingListener(
      '127.0.0.1',
      port,
      LOOPBACK_PROBE_TIMEOUT_MS
    ).then(
      () => false,
      () => true
    )
    if (answered) {
      return
    }
    if (Date.now() >= deadline) {
      throw new Error(`Port forward did not start listening on 127.0.0.1:${port}`)
    }
    await new Promise((resolve) => setTimeout(resolve, LISTENER_POLL_MS))
  }
}

type FreeLocalPortForward = {
  remotePort: number
  add: (localPort: number) => Promise<PortForwardEntry>
  remove: (id: string) => Promise<unknown>
  /** Whether the forward listens on [::1] too; when it doesn't, an OS-picked port is checked there,
   *  since a browser tries [::1] first. */
  holdsIpv6Loopback: boolean
  /** Local ports saved for other forwards that aren't listening now; taking one would replace them. */
  reservedLocalPorts?: ReadonlySet<number>
  /** For a forward whose start can return before it listens: wait this long for 127.0.0.1 to answer,
   *  while `isOpen` says the forward is still up. */
  listening?: { timeoutMs: number; isOpen: (entry: PortForwardEntry) => boolean }
}

// One automatic start at a time across every host: a start that hasn't bound yet leaves its port
// looking free, and a second host's start could take it and answer the first one's probe.
const AUTOMATIC_FORWARD_START_KEY = 'automatic-forward-start'

/** Starts a forward of `remotePort` on the same port number here when nothing answers on it, else
 *  the next free one, else one the OS picks. */
export function addForwardOnFreeLocalPort(
  forward: FreeLocalPortForward
): Promise<PortForwardEntry> {
  return serializePortForwardChange(AUTOMATIC_FORWARD_START_KEY, async () => {
    const entry = await startOnFreeLocalPort(forward)
    const { listening } = forward
    if (listening) {
      await waitForLoopbackListener(entry.localPort, listening.timeoutMs, () =>
        listening.isOpen(entry)
      ).catch(async (error: unknown) => {
        await forward.remove(entry.id)
        throw error
      })
    }
    return entry
  })
}

async function startOnFreeLocalPort(forward: FreeLocalPortForward): Promise<PortForwardEntry> {
  const { remotePort, add, reservedLocalPorts } = forward
  const lastCandidate = Math.min(remotePort + NEXT_PORT_ATTEMPTS - 1, 65_535)
  for (let candidate = remotePort; candidate <= lastCandidate; candidate++) {
    if (reservedLocalPorts?.has(candidate) || (await loopbackPortAnswers(candidate))) {
      continue
    }
    try {
      return await add(candidate)
    } catch (error) {
      // Lost races and privileged ports move on to the next number; a dead connection stops here.
      if (!isLocalBindFailure(error)) {
        throw error
      }
    }
  }
  return addOnFreeOsPort(forward)
}

/** The OS picks a port free on 127.0.0.1 only. Where the forward holds [::1] too, a collision there
 *  fails the start; where it doesn't, [::1] is probed. Either way, or on a reserved port, pick again. */
async function addOnFreeOsPort({
  add,
  remove,
  holdsIpv6Loopback,
  reservedLocalPorts
}: FreeLocalPortForward): Promise<PortForwardEntry> {
  for (let attempt = 1; ; attempt++) {
    try {
      const entry = await add(0)
      if (reservedLocalPorts?.has(entry.localPort)) {
        await remove(entry.id)
        throw Object.assign(
          new Error(`Local port ${entry.localPort} is saved for another forward`),
          {
            code: 'EADDRINUSE'
          }
        )
      }
      if (!holdsIpv6Loopback) {
        await assertIpv6LoopbackPortFree(entry.localPort).catch(async (error: unknown) => {
          await remove(entry.id)
          throw error
        })
      }
      return entry
    } catch (error) {
      if (attempt >= OS_PORT_ATTEMPTS || !isLocalBindFailure(error)) {
        throw error
      }
    }
  }
}

const BIND_FAILURE_CODES = new Set(['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL'])
// OpenSSH reports its own -L listen failure only as `cannot listen to port: <port>`.
const BIND_FAILURE_MESSAGE = /\b(EADDRINUSE|EACCES|EADDRNOTAVAIL)\b|cannot listen to port/

/** Whether a forward failed to listen here, as opposed to its connection failing. Providers report
 *  the bind error as a code, a cause, or only in their message. */
function isLocalBindFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const code = 'code' in error ? error.code : undefined
  return (
    (typeof code === 'string' && BIND_FAILURE_CODES.has(code)) ||
    (typeof error.cause === 'string' && BIND_FAILURE_CODES.has(error.cause)) ||
    BIND_FAILURE_MESSAGE.test(error.message)
  )
}
