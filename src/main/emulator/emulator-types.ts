export type EmulatorBackendKind = 'ios' | 'android'

export type EmulatorStreamCodec = 'mjpeg' | 'h264'

export type EmulatorSessionInfo = {
  deviceUdid: string
  wsUrl: string
  streamUrl: string
  axUrl?: string
  helperPid?: number
  streamCodec?: EmulatorStreamCodec
  backend?: EmulatorBackendKind
}
