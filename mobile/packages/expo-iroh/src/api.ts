import ExpoIrohModule from './ExpoIrohModule'
import type { IrohConnectResult, IrohDialHints, IrohPathInfo, IrohStartResult } from './types'

/** Bind the local endpoint with its home relay; null selects the N0 preset. */
export async function irohStart(homeRelayUrl: string | null): Promise<IrohStartResult> {
  return ExpoIrohModule.irohStart(homeRelayUrl)
}

/** Dial peer by EndpointId; opens one long-lived bi-stream. */
export async function irohConnect(
  endpointId: string,
  hints?: IrohDialHints
): Promise<IrohConnectResult> {
  return ExpoIrohModule.irohConnect(
    endpointId,
    hints?.relayUrl ?? null,
    hints?.directAddresses ?? []
  )
}

/** Frame + write opaque payload (base64). */
export async function irohSend(connectionId: string, bytesBase64: string): Promise<void> {
  return ExpoIrohModule.irohSend(connectionId, bytesBase64)
}

/** Snapshot of selected path type (polls paths(); never watchPaths). */
export async function irohPathInfo(connectionId: string): Promise<IrohPathInfo> {
  return ExpoIrohModule.irohPathInfo(connectionId)
}

export async function irohClose(connectionId: string): Promise<void> {
  return ExpoIrohModule.irohClose(connectionId)
}

/** Tear down all connections and the local endpoint. */
export async function irohStop(): Promise<void> {
  return ExpoIrohModule.irohStop()
}
