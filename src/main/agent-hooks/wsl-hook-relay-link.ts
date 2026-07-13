// Envelope forwarding and death handling for one live WSL relay link.
// Extracted from the manager so its state machine stays readable; the manager
// decides what a dead link means (cooldown, restart), this module guarantees
// it finds out exactly once, whichever signal fires first.
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { AGENT_HOOK_NOTIFICATION_METHOD } from '../../shared/agent-hook-relay'
import { wslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'

export type WslRelayLinkOptions = {
  mux: SshChannelMultiplexer
  child: ChildProcessWithoutNullStreams
  distro: string
  ingest: (envelope: Record<string, unknown>, connectionId: string) => void
  warn: (message: string) => void
  /** Called exactly once when the link dies — from EITHER a mux dispose
   *  (protocol error, keepalive timeout) or the child exiting. A mux death
   *  without child death would otherwise blackhole every later envelope
   *  while the guest keeps returning 204 to hook clients. */
  onDead: (reason: string) => void
}

export function wireWslRelayLink(options: WslRelayLinkOptions): void {
  const { mux, child, distro, ingest, warn, onDead } = options
  const connectionId = wslHookRelayConnectionId(distro)

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
    // Trust boundary: ingestRemote re-validates paneKey/tabId and
    // re-normalizes the payload, same as the SSH relay path.
    ingest(params, connectionId)
  })

  let dead = false
  const die = (reason: string): void => {
    if (dead) {
      return
    }
    dead = true
    mux.dispose()
    child.kill()
    onDead(reason)
  }
  mux.onDispose((reason) => die(`mux disposed (${reason})`))
  child.on('close', () => die('process exited'))
}
