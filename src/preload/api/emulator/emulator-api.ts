export type EmulatorApi = {
  onPaneFocus: (callback: (data: { worktreeId: string }) => void) => () => void
  onAutoAttach: (
    callback: (data: {
      worktreeId: string
      info: { deviceUdid: string; streamUrl: string; wsUrl: string; axUrl?: string }
    }) => void
  ) => () => void
  startFrameStream: (args: { streamUrl: string; streamKey?: string }) => Promise<{
    streamId: string
  }>
  stopFrameStream: (args: { streamId: string }) => Promise<void>
  /** Loopback URLs here that tunnel to a paired runtime's simulator helper. */
  forwardRuntimeSession: (args: {
    environmentId: string
    streamUrl?: string
    wsUrl?: string
  }) => Promise<{ streamUrl?: string; wsUrl?: string }>
  onFrameStreamFrame: (
    callback: (data: { streamId: string; bytes: ArrayBuffer }) => void
  ) => () => void
  onFrameStreamError: (
    callback: (data: { streamId: string; message: string }) => void
  ) => () => void
  /** `streamUrl` names a forwarded runtime stream; local sessions resolve by device. */
  startVideoStream: (args: {
    deviceId: string
    streamId: string
    streamUrl?: string
  }) => Promise<{ streamId: string }>
  stopVideoStream: (args: { streamId: string }) => Promise<void>
  onVideoStreamMeta: (
    callback: (data: {
      streamId: string
      deviceId: string
      meta: { codecId: string; width: number; height: number }
    }) => void
  ) => () => void
  sendScrcpyTouch: (touch: {
    deviceId: string
    type: 'begin' | 'move' | 'end'
    x: number
    y: number
  }) => void
  /** Resolves false when the device has no live scrcpy control socket. */
  sendScrcpyKeyboard: (
    input:
      | { deviceId: string; text: string; paste?: boolean; hid?: { usage: number; shift: boolean } }
      | { deviceId: string; key: string; shift: boolean; hid?: { usage: number; shift: boolean } }
  ) => Promise<boolean>
  onVideoStreamFrame: (
    callback: (data: {
      streamId: string
      deviceId: string
      config: boolean
      keyFrame: boolean
      bytes: ArrayBuffer
    }) => void
  ) => () => void
}
