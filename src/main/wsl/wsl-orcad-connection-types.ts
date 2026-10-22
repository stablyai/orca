import type { WslOrcadDeferredUpdate } from './wsl-orcad-deploy'

/** One open bridge to a distro's orcad, as the connection manager publishes it. */
export type WslOrcadConnection = {
  distro: string
  environmentId: string
  /** The loopback port on this machine the pairing offer points at. */
  localPort: number
  /** orcad's port inside the distro. */
  remotePort: number
  fullVersion: string
  /** orcad's pid inside the distro, from its pid file; null when unreadable. */
  pid: number | null
  /** orcad's pairing code, with its endpoint rewritten to `ws://127.0.0.1:<localPort>`. */
  pairingOffer: string
  /** An app update the incumbent `fullVersion` is waiting to take (live terminals). */
  deferredUpdate: WslOrcadDeferredUpdate | null
  close(): Promise<void>
}
