import type { EmulatorBackendKind, EmulatorStreamCodec } from './emulator-types'

export type EmulatorSessionState = {
  deviceUdid: string
  wsUrl: string
  streamUrl: string
  axUrl?: string
  pid?: number
  managed: boolean
  initialized: boolean
  backend: EmulatorBackendKind
  streamCodec: EmulatorStreamCodec
}

export type EmulatorBridgeOptions = {
  waitForEndpointReady?: (endpoint: string) => Promise<boolean>
  fetchAccessibilityTree?: (axUrl: string) => Promise<unknown>
}
