import type { EmulatorVideoApi } from '../../shared/emulator-video-stream'
import type { EmulatorControlApi } from '../../shared/emulator-control-stream'

export type EmulatorApi = EmulatorVideoApi &
  EmulatorControlApi & {
    onPaneFocus: (callback: (data: { worktreeId: string }) => void) => () => void
    onAutoAttach: (
      callback: (data: {
        worktreeId: string
        info: {
          deviceUdid: string
          streamUrl: string
          avccStreamUrl?: string
          wsUrl: string
          axUrl?: string
        }
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
      callback: (data: { streamId: string; message: string }) => void
    ) => () => void
    sendScrcpyTouch: (touch: {
      deviceId: string
      type: 'begin' | 'move' | 'end'
      x: number
      y: number
    }) => void
    /** Resolves false when the device has no live scrcpy control socket. */
    sendScrcpyKeyboard: (
      input: { deviceId: string; text: string } | { deviceId: string; key: string; shift: boolean }
    ) => Promise<boolean>
  }
