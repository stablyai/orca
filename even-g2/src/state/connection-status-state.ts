// Unit 4: wires connection state + compat verdict into HudStore's ConnectionSlice.
// RpcPort (Unit 0) has no onState, so callers (Unit 8, wiring the real OrcaSocketClient)
// supply a small onState subscribe fn alongside a probeCompat() — this keeps the slice
// decoupled from OrcaSocketClient's concrete type.
import { evaluateCompat, type CompatVerdict } from '@orca-shared/protocol-compat'
import type { HudStore } from './hud-store'
import type { ConnectionState, RpcPort, RpcSuccess } from '../transport/orca-rpc-wire'

// Mirrors mobile/src/transport/protocol-version.ts (MOBILE_PROTOCOL_VERSION /
// MIN_COMPATIBLE_DESKTOP_VERSION) — even-g2 is a mobile-shaped client of the same desktop
// RPC surface, so it reuses the same version numbers.
export const CLIENT_PROTOCOL_VERSION = 3
export const MIN_COMPATIBLE_DESKTOP_VERSION = 2

type StatusGetResult = {
  protocolVersion?: number
  minCompatibleMobileVersion?: number
}

/** Calls status.get via the given port and runs the canonical compat evaluator. */
export async function probeCompatViaStatusGet(port: RpcPort): Promise<CompatVerdict> {
  const response = await port.sendRequest('status.get')
  const result = (response.ok ? (response as RpcSuccess).result : {}) as StatusGetResult
  return evaluateCompat({
    mobileProtocolVersion: CLIENT_PROTOCOL_VERSION,
    minCompatibleDesktopVersion: MIN_COMPATIBLE_DESKTOP_VERSION,
    desktopProtocolVersion: result.protocolVersion,
    desktopMinCompatibleMobileVersion: result.minCompatibleMobileVersion
  })
}

export type ConnectionStatusInputs = {
  onState(cb: (state: ConnectionState) => void): () => void
  probeCompat(): Promise<CompatVerdict>
}

/** Builds ConnectionStatusInputs from a real RpcPort + an onState subscribe fn. */
export function createConnectionStatusInputs(
  port: RpcPort,
  onState: (cb: (state: ConnectionState) => void) => () => void
): ConnectionStatusInputs {
  return { onState, probeCompat: () => probeCompatViaStatusGet(port) }
}

/** Wires connection state + compat verdict into store.connection. Returns an unsubscribe fn. */
export class ConnectionStatusController {
  private probeSeq = 0

  constructor(
    private readonly store: HudStore,
    private readonly inputs: ConnectionStatusInputs
  ) {}

  start(hostId: string | null = null): () => void {
    return this.inputs.onState((state) => this.handleState(hostId, state))
  }

  private handleState(hostId: string | null, state: ConnectionState): void {
    this.store.update((s) => ({
      ...s,
      connection: {
        ...s.connection,
        hostId,
        state,
        lastError: state === 'auth-failed' ? s.connection.lastError : undefined
      }
    }))

    if (state !== 'connected') {
      return
    }

    const seq = ++this.probeSeq
    this.inputs
      .probeCompat()
      .then((compat) => {
        if (seq !== this.probeSeq) {
          return
        } // superseded by a later state change
        this.store.update((s) => ({ ...s, connection: { ...s.connection, compat } }))
      })
      .catch((error: unknown) => {
        if (seq !== this.probeSeq) {
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        this.store.update((s) => ({ ...s, connection: { ...s.connection, lastError: message } }))
      })
  }
}
