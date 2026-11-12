import { registerEmulatorFrameStreamHandlers } from '../emulator-frame-stream'
import { registerEmulatorVideoStreamHandlers } from '../emulator-video-stream'
import { registerEmulatorScrcpyTouchHandler } from '../emulator-scrcpy-touch'
import { registerEmulatorScrcpyKeyboardHandler } from '../emulator-scrcpy-keyboard'

/** The emulator's four IPC lanes register together; extracted to keep the core registrar under the line cap. */
export function registerEmulatorHandlers(
  resolveIosVideoStreamUrl: (deviceId: string) => string | null | undefined
): void {
  registerEmulatorFrameStreamHandlers()
  registerEmulatorVideoStreamHandlers(resolveIosVideoStreamUrl)
  registerEmulatorScrcpyTouchHandler()
  registerEmulatorScrcpyKeyboardHandler()
}
