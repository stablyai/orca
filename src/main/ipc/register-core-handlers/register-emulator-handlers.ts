import { registerEmulatorFrameStreamHandlers } from '../emulator-frame-stream'
import { registerEmulatorVideoStreamHandlers } from '../emulator-video-stream'
import { registerEmulatorScrcpyTouchHandler } from '../emulator-scrcpy-touch'
import { registerEmulatorScrcpyKeyboardHandler } from '../emulator-scrcpy-keyboard'

/** The emulator's four IPC lanes register together; extracted to keep the core registrar under the line cap. */
export function registerEmulatorHandlers(): void {
  registerEmulatorFrameStreamHandlers()
  registerEmulatorVideoStreamHandlers()
  registerEmulatorScrcpyTouchHandler()
  registerEmulatorScrcpyKeyboardHandler()
}
