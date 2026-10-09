// Which emulator backend owns a device/session.
export type EmulatorBackendKind = 'ios' | 'android' | 'harmonyos'

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

export type EmulatorActiveSession = EmulatorSessionInfo & {
  worktreeId: string
  backend: EmulatorBackendKind
}
