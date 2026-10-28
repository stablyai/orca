import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { AGENT_HOOK_NOTIFICATION_METHOD } from '../../shared/agent-hook-relay'
import { wslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'
import { CLAUDE_AGENT_VIEW_RELAY_METHOD } from '../../shared/claude-agent-view'

export type WslRelayLinkOptions = {
  mux: SshChannelMultiplexer
  child: ChildProcessWithoutNullStreams
  distro: string
  ingest: (envelope: Record<string, unknown>, connectionId: string) => void
  receiveClaudeAgentView?: (body: unknown) => unknown
  bindInterruptReconciliation?: (
    mux: SshChannelMultiplexer,
    connectionId: string,
    isCurrent: () => boolean
  ) => () => void
  warn: (message: string) => void
  /** Notify once on mux or child death; a dead mux can otherwise silently discard hook events. */
  onDead: (reason: string) => void
}

export function wireWslRelayLink(options: WslRelayLinkOptions): void {
  const { mux, child, distro, ingest, warn, onDead } = options
  const connectionId = wslHookRelayConnectionId(distro)
  let dead = false
  mux.onRequest(CLAUDE_AGENT_VIEW_RELAY_METHOD, ({ body }) =>
    dead ? {} : (options.receiveClaudeAgentView?.(body) ?? {})
  )
  const unbindInterrupt = options.bindInterruptReconciliation?.(mux, connectionId, () => !dead)

  mux.onNotification((method, params) => {
    if (method !== AGENT_HOOK_NOTIFICATION_METHOD) {
      return
    }
    if (typeof (params as { paneKey?: unknown }).paneKey !== 'string') {
      return
    }
    if (process.env.ORCA_WSL_HOOK_RELAY_DEBUG === '1') {
      const p = params as { paneKey?: string; payload?: { state?: string } }
      warn(
        `[agent-hooks] WSL relay envelope (${distro}): pane=${p.paneKey} state=${p.payload?.state ?? '?'}`
      )
    }
    // Revalidate identifiers and payload at ingest, just as for SSH relays.
    ingest(params, connectionId)
  })

  const die = (reason: string): void => {
    if (dead) {
      return
    }
    dead = true
    unbindInterrupt?.()
    mux.dispose()
    child.kill()
    onDead(reason)
  }
  mux.onDispose((reason) => die(`mux disposed (${reason})`))
  child.on('close', () => die('process exited'))
}
