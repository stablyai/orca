// Which emulator backend owns a device/session. Lives here (the low-level types
// file) so both the bridge types and the backend interface import it without a cycle.
export type EmulatorBackendKind = 'ios' | 'android'

// How the live pane decodes a backend's frames: iOS serve-sim is MJPEG, Android scrcpy is H.264.
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

export type EmulatorCliTarget = {
  worktreeId?: string
  deviceUdid?: string
  emulatorId?: string // Orca-generated id from list (for stability, like browserPageId)
}
