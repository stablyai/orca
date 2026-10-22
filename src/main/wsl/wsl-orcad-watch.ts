/**
 * The liveness watch: one bridge into orcad's port, held open and never written to. orcad's HTTP
 * server keeps a connection that never sent a request, so the bridge ends only when orcad closes
 * it (exit 0, measured ~69 ms after killing orcad) or its distro stops (exit 1, ~40 ms after
 * `wsl --terminate`). Opening it doubles as the port probe: READY or REFUSED.
 */
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import { openOrcadStdioBridgeChannel, resolveOrcadStdioBridge } from '../ssh/orcad-stdio-bridge'
import {
  OrcadStdioBridgeDecoder,
  type OrcadStdioBridgeSignal
} from '../managed-server/lifecycle/orcad-stdio-bridge-stream'
import type { RemoteCommandChannel } from '../managed-server/install/remote-install-transport'

export type WslOrcadWatch = {
  /** `ready` holds a live channel; anything else holds nothing. */
  signal: 'ready' | 'refused' | 'unverifiable'
  /** Called once, with the bridge's exit code, when a `ready` watch ends on its own. */
  onExit(listener: (code: number | null) => void): void
  close(): void
}

const WATCH_OPEN_TIMEOUT_MS = 10_000

function inertWatch(signal: 'refused' | 'unverifiable'): WslOrcadWatch {
  return { signal, onExit: () => {}, close: () => {} }
}

export async function openWslOrcadWatch(
  transport: OrcadHostTransport,
  port: number,
  timeoutMs = WATCH_OPEN_TIMEOUT_MS
): Promise<WslOrcadWatch> {
  let channel: RemoteCommandChannel
  try {
    channel = await openOrcadStdioBridgeChannel(
      transport,
      await resolveOrcadStdioBridge(transport, port)
    )
  } catch {
    return inertWatch('unverifiable')
  }
  return watchChannel(channel, timeoutMs)
}

/** Exported for tests: any channel speaking the bridge's sentinel protocol. */
export function watchChannel(
  channel: RemoteCommandChannel,
  timeoutMs: number
): Promise<WslOrcadWatch> {
  const decoder = new OrcadStdioBridgeDecoder('raw')
  let exitCode: number | null = null
  let ended = false
  let closedByUs = false
  let exitListener: ((code: number | null) => void) | null = null
  const close = (): void => {
    closedByUs = true
    try {
      channel.close()
    } catch {
      // Already gone.
    }
    decoder.destroy()
  }
  channel.on('exit', (code: unknown) => {
    exitCode = typeof code === 'number' ? code : null
  })
  channel.on('error', () => {})
  decoder.on('error', () => {})
  decoder.resume()
  channel.pipe(decoder)
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => settle('unverifiable'), timeoutMs)
    function settle(signal: OrcadStdioBridgeSignal | 'unverifiable'): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (signal !== 'ready') {
        close()
        resolve(inertWatch(signal === 'refused' ? 'refused' : 'unverifiable'))
        return
      }
      resolve({
        signal: 'ready',
        onExit: (listener) => {
          exitListener = listener
          if (ended && !closedByUs) {
            listener(exitCode)
          }
        },
        close
      })
    }
    decoder.on('signal', (signal: OrcadStdioBridgeSignal) => settle(signal))
    channel.on('close', (code: unknown) => {
      ended = true
      exitCode ??= typeof code === 'number' ? code : null
      settle('unverifiable')
      if (!closedByUs) {
        exitListener?.(exitCode)
        exitListener = null
      }
    })
  })
}
