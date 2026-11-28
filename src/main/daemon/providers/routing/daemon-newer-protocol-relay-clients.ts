import { readDaemonPidRecord } from '../../endpoint/identity/daemon-endpoint-incarnation'
import { getDaemonRuntimeDir } from '../../launch/daemon-launch-paths'
import {
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonTokenPath
} from '../../launch/daemon-spawner'
import { DaemonProtocolError } from '../../protocol/daemon-errors'
import { DaemonClient } from '../../transport/client/daemon-client'
import {
  writeRefused,
  type WriteSettlement
} from '../../../../shared/terminal/pty/lifecycle/pty-write-settlement'
import { heldNewerDaemonProtocols } from './daemon-newer-protocol-hold'

/**
 * What an older app may ask a newer daemon: the frozen relay set, so a chat it kept reattaches after
 * a downgrade. Never a spawn (new chats go to this build's own daemon) and never a terminal request.
 */
const NEWER_DAEMON_RELAY_REQUESTS: ReadonlySet<string> = new Set([
  'relayList',
  'relayAttach',
  'relayWrite',
  'relayAck',
  'relayAcks',
  'relayDetach',
  'relayClose'
])

/** Says hello at the newer daemon's own version, then refuses everything outside the relay set. */
class NewerDaemonRelayClient extends DaemonClient {
  override request<T = unknown>(
    type: string,
    payload: unknown,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<T> {
    if (!NEWER_DAEMON_RELAY_REQUESTS.has(type)) {
      return Promise.reject(new DaemonProtocolError(`A newer daemon only relays chats: ${type}`))
    }
    return super.request<T>(type, payload, timeoutMs, signal)
  }

  override notify(): boolean {
    return false
  }

  override notifyWithSettlement(): Promise<WriteSettlement> {
    return Promise.resolve(writeRefused('endpoint_disconnected'))
  }
}

/** By protocol; bounded by the newer generations held at launch. */
const clients = new Map<number, NewerDaemonRelayClient>()

/** A relay-only client per newer daemon still held; one stopped since is disconnected and dropped. */
export function newerDaemonRelayClients(runtimeDir = getDaemonRuntimeDir()): DaemonClient[] {
  const held = new Set(heldNewerDaemonProtocols())
  for (const [protocolVersion, client] of clients) {
    if (!held.has(protocolVersion)) {
      client.disconnect()
      clients.delete(protocolVersion)
    }
  }
  for (const protocolVersion of held) {
    if (!clients.has(protocolVersion)) {
      const client = new NewerDaemonRelayClient({
        socketPath: getDaemonSocketPath(runtimeDir, protocolVersion),
        tokenPath: getDaemonTokenPath(runtimeDir, protocolVersion),
        protocolVersion
      })
      clients.set(protocolVersion, client)
      // Connected once here so launch listing can read its relays; later asks reconnect it.
      void client.ensureConnected().catch(() => {})
    }
  }
  return [...clients.values()]
}

/** The daemon start this instance names is a held newer generation's, by its pid record. */
export function newerDaemonHoldsInstance(
  instance: string,
  runtimeDir = getDaemonRuntimeDir()
): boolean {
  return heldNewerDaemonProtocols().some(
    (protocolVersion) =>
      readDaemonPidRecord(getDaemonPidPath(runtimeDir, protocolVersion))?.launchNonce === instance
  )
}
