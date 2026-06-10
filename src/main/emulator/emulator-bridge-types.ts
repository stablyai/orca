export type EmulatorSessionState = {
  deviceUdid: string
  wsUrl: string
  streamUrl: string
  axUrl?: string
  pid?: number
  managed: boolean
  initialized: boolean
}

export type EmulatorBridgeOptions = {
  waitForEndpointReady?: (endpoint: string) => Promise<boolean>
}
