import type { SshTarget } from '../../shared/ssh-types'
import { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { SshConnection } from '../ssh/ssh-connection'
import { deployAndLaunchRelay } from '../ssh/ssh-relay-deploy'
import { assertSshConnectsNotFenced } from './ssh-connect-attempt-registry'
import { relayGracePeriodForTarget } from './ssh-connection-state-callbacks'
import { getCurrentMainWindow } from './ssh-ipc-context'
import { requestCredential } from './ssh-passphrase'

type SshMaintenanceOperation = { targetId: string; settled: Promise<void>; abort: () => void }

// Why: these transports belong to no manager or session, so this is the shutdown drain's only route to them.
export const sshMaintenanceOperations = new Set<SshMaintenanceOperation>()

/**
 * Runs `fn` over a transport to the host that nothing else can see: it is never put in the
 * connection manager, a relay session or a provider registry, publishes no state and rotates no
 * authority. Why: ending a disconnected host's terminals or resetting its relay must not bring the
 * host back up, even briefly, for any of the readers of those registries.
 */
export async function withSshMaintenanceTransport<T>(
  target: SshTarget,
  fn: (conn: SshConnection, signal: AbortSignal) => Promise<T>
): Promise<T> {
  assertSshConnectsNotFenced()
  const ended = new AbortController()
  const lost = Promise.withResolvers<never>()
  // Why: only the race below observes it; our own disconnect's late 'disconnected' must not surface.
  lost.promise.catch(() => undefined)
  let connected = false
  const conn = new SshConnection(target, {
    onStateChange: (_targetId, state) => {
      // Why reject instead of riding out the reconnect ladder: nobody waits on this transport
      // coming back, and a redial would reopen it behind the operation's back.
      if (connected && state.status !== 'connected') {
        lost.reject(new Error(`The SSH connection to ${target.label} dropped (${state.status})`))
      }
    },
    onCredentialRequest: (targetId, kind, detail, echo, signal) =>
      requestCredential(getCurrentMainWindow, targetId, kind, detail, echo, signal)
  })
  const operation = (async () => {
    await conn.connect()
    connected = true
    if (conn.getState().status !== 'connected') {
      throw new Error(`The SSH connection to ${target.label} dropped while opening`)
    }
    return fn(conn, ended.signal)
  })()
  const settled = operation.then(
    () => undefined,
    () => undefined
  )
  // Why registered in the same turn as the fence check: a drain either sees this or fenced it out.
  const entry: SshMaintenanceOperation = {
    targetId: target.id,
    settled,
    abort: () => void conn.disconnect()
  }
  sshMaintenanceOperations.add(entry)
  try {
    return await Promise.race([operation, lost.promise])
  } finally {
    ended.abort()
    await conn.disconnect().catch((error: unknown) => {
      console.warn(
        `[ssh] Failed to close the maintenance connection to ${target.id}: ${error instanceof Error ? error.message : String(error)}`
      )
    })
    // Why: fn's bookkeeping must land inside the caller's lifecycle turn, not after it.
    await settled
    sshMaintenanceOperations.delete(entry)
  }
}

/** The same channel with a relay: deploys or reuses the host's relay and hands `fn` a bare mux. */
export function withSshMaintenanceRelay<T>(
  target: SshTarget,
  fn: (mux: SshChannelMultiplexer) => Promise<T>
): Promise<T> {
  return withSshMaintenanceTransport(target, async (conn, signal) => {
    const { transport } = await deployAndLaunchRelay(
      conn,
      undefined,
      relayGracePeriodForTarget(target),
      target.id
    )
    const mux = new SshChannelMultiplexer(transport)
    const dispose = (): void => mux.dispose()
    signal.addEventListener('abort', dispose, { once: true })
    try {
      signal.throwIfAborted()
      return await fn(mux)
    } finally {
      signal.removeEventListener('abort', dispose)
      mux.dispose()
    }
  })
}
