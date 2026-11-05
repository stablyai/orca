import { registerEmulatorFrameStreamHandlers } from '../emulator/emulator-frame-stream'
import { registerEmulatorVideoStreamHandlers } from '../emulator/emulator-video-stream'
import { registerEmulatorScrcpyTouchHandler } from '../emulator/emulator-scrcpy-touch'
import { registerEmulatorScrcpyKeyboardHandler } from '../emulator/emulator-scrcpy-keyboard'

/** The emulator's four IPC lanes register together; extracted to keep the core registrar under the line cap. */
export function registerEmulatorHandlers(): void {
  registerEmulatorFrameStreamHandlers()
  registerEmulatorVideoStreamHandlers()
  registerEmulatorScrcpyTouchHandler()
  registerEmulatorScrcpyKeyboardHandler()
}
