import type { NativeVideoRequest } from '../../shared/emulator-native-video'

export type EmulatorApi = {
  startNativeVideoStream: (args: NativeVideoRequest) => Promise<void>
  stopNativeVideoStream: (streamId: string) => Promise<void>
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
  onFrameStreamFrame: (
    callback: (data: { streamId: string; bytes: ArrayBuffer }) => void
  ) => () => void
  onFrameStreamError: (
    callback: (data: { streamId: string; message: string; retryWithScrcpy?: boolean }) => void
  ) => () => void
  startVideoStream: (args: { deviceId: string; streamId: string }) => Promise<{ streamId: string }>
  stopVideoStream: (args: { streamId: string }) => Promise<void>
  onVideoStreamMeta: (
    callback: (data: {
      streamId: string
      deviceId: string
      meta: { codecId: string; width: number; height: number }
    }) => void
  ) => () => void
  sendScrcpyScroll: (scroll: {
    deviceId: string
    x: number
    y: number
    horizontal: number
    vertical: number
  }) => void
  sendScrcpyTouch: (touch: {
    deviceId: string
    type: 'begin' | 'move' | 'end'
    x: number
    y: number
    pointerType?: string
  }) => void
  /** Resolves false when the device has no live scrcpy control socket. */
  sendScrcpyKeyboard: (
    input:
      | { deviceId: string; text: string }
      | { deviceId: string; key: string; shift: boolean; ctrl?: boolean }
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
