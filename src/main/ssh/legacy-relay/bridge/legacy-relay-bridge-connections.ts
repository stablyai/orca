/**
 * Where the bridge opens each old relay's long-lived `--connect` channel.
 * sshd's MaxSessions (OpenSSH default 10) caps sessions per connection, and one host can keep a relay per
 * desktop update it outlived; on the target's own connection they starved every later exec ("open failed").
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
import type { ClientChannel } from 'ssh2'
import { SshConnection } from '../../connection/ssh-connection'
import type { SshExecOptions } from '../../connection/ssh-exec-options'
import { isSshSessionLimitError } from '../../connection/ssh-session-limit-error'

/** Below OpenSSH's default 10, leaving each side connection room for its own short execs. */
export const RELAY_CHANNELS_PER_SIDE_CONNECTION = 8
/** Fallback onto the target's connection keeps 4 of the default 10 for its own work. */
export const RELAY_CHANNELS_ON_PRIMARY = 6

export const LEGACY_RELAY_CHANNEL_BUDGET_EXHAUSTED = 'legacy_relay_channel_budget_exhausted'

type Side = {
  conn: SshConnection
  channels: number
  /** Lowered when the host's own MaxSessions is below ours. */
  limit: number
  ready: Promise<void>
  failed: boolean
}

export type LegacyRelayBridgeConnections = {
  open: (command: string, options?: SshExecOptions) => Promise<ClientChannel>
  /** Close side connections; relay daemons and their shells keep running. */
  dispose: () => void
}

export function createLegacyRelayBridgeConnections(deps: {
  primary: () => SshConnection | null
  /** Tests swap the connection; production signs in like the target without ever prompting. */
  createSide?: (primary: SshConnection) => SshConnection
}): LegacyRelayBridgeConnections {
  const createSide =
    deps.createSide ??
    ((primary: SshConnection) =>
      new SshConnection(
        primary.getTarget(),
        // No credential callback: a side connection never prompts, it falls back instead.
        { onStateChange: () => {} },
        primary.getReusableCredentials() ?? undefined
      ))
  const sides: Side[] = []
  let primaryChannels = 0
  // A sign-in a side could not repeat stays unrepeatable for this primary; retry after it reconnects.
  let sidesRefusedFor: SshConnection | null = null
  let disposed = false

  const closeSide = (side: Side): void => {
    const index = sides.indexOf(side)
    if (index !== -1) {
      sides.splice(index, 1)
    }
    void side.conn.disconnect({ quiet: true }).catch(() => {})
  }

  const releaseOnClose = (channel: ClientChannel, release: () => void): void => {
    channel.once('close', release)
  }

  const openOnSide = async (
    primary: SshConnection,
    command: string,
    options: SshExecOptions | undefined
  ): Promise<ClientChannel | null> => {
    let side = sides.find((entry) => !entry.failed && entry.channels < entry.limit)
    if (!side) {
      const conn = createSide(primary)
      const created: Side = {
        conn,
        channels: 0,
        limit: RELAY_CHANNELS_PER_SIDE_CONNECTION,
        ready: conn.connect(),
        failed: false
      }
      sides.push(created)
      side = created
    }
    // Reserve before awaiting so concurrent opens cannot overfill one connection.
    side.channels += 1
    try {
      await side.ready
    } catch (error) {
      if (!side.failed) {
        console.warn(
          '[legacy-relay] side SSH connection failed; relay channels share the target connection',
          error instanceof Error ? error.message : error
        )
      }
      side.failed = true
      sidesRefusedFor = primary
      side.channels -= 1
      closeSide(side)
      return null
    }
    let channel: ClientChannel
    try {
      channel = await side.conn.exec(command, options)
    } catch (error) {
      side.channels -= 1
      const full = isSshSessionLimitError(error) && side.channels > 0
      if (full) {
        // This host allows fewer sessions per connection; cap this one and open the relay elsewhere.
        side.limit = side.channels
      }
      if (side.channels === 0) {
        closeSide(side)
      }
      if (full && !disposed) {
        return openOnSide(primary, command, options)
      }
      throw error
    }
    const owner = side
    releaseOnClose(channel, () => {
      owner.channels -= 1
      if (owner.channels === 0) {
        closeSide(owner)
      }
    })
    if (disposed) {
      channel.close()
    }
    return channel
  }

  const openOnPrimary = async (
    primary: SshConnection,
    command: string,
    options: SshExecOptions | undefined
  ): Promise<ClientChannel> => {
    // An over-budget relay stays unverifiable and its shell keeps running; the host stays usable.
    if (primaryChannels >= RELAY_CHANNELS_ON_PRIMARY) {
      console.warn('[legacy-relay] relay channel budget on the target connection is full')
      throw new Error(LEGACY_RELAY_CHANNEL_BUDGET_EXHAUSTED)
    }
    primaryChannels += 1
    let channel: ClientChannel
    try {
      channel = await primary.exec(command, options)
    } catch (error) {
      primaryChannels -= 1
      throw error
    }
    releaseOnClose(channel, () => {
      primaryChannels -= 1
    })
    return channel
  }

  return {
    open: async (command, options) => {
      if (disposed) {
        throw new Error('legacy_relay_bridge_disposed')
      }
      const primary = deps.primary()
      if (!primary) {
        throw new Error('ssh_connection_unavailable')
      }
      if (primary.usesSystemSshTransport()) {
        // Without a ControlMaster every exec is its own ssh process and sshd connection: no shared cap.
        // With one, a side connection would join the same sshd session, so only the budget helps.
        return primary.canRunConcurrentExecCommands()
          ? openOnPrimary(primary, command, options)
          : primary.exec(command, options)
      }
      if (sidesRefusedFor !== primary) {
        const channel = await openOnSide(primary, command, options)
        if (channel) {
          return channel
        }
      }
      return openOnPrimary(primary, command, options)
    },
    dispose: () => {
      disposed = true
      for (const side of sides.splice(0)) {
        void side.conn.disconnect({ quiet: true }).catch(() => {})
      }
    }
  }
}

const byTarget = new Map<string, LegacyRelayBridgeConnections>()

/** Each target's relay channels: one set per bridge, created on first use. */
export const legacyRelayChannels = {
  for(targetId: string, primary: () => SshConnection | null): LegacyRelayBridgeConnections {
    const existing = byTarget.get(targetId)
    if (existing) {
      return existing
    }
    const created = createLegacyRelayBridgeConnections({ primary })
    byTarget.set(targetId, created)
    return created
  },
  /** One target's, or with no id every target's; relay daemons and their shells keep running. */
  dispose(targetId?: string): void {
    for (const [id, channels] of byTarget) {
      if (targetId === undefined || id === targetId) {
        byTarget.delete(id)
        channels.dispose()
      }
    }
  }
}
