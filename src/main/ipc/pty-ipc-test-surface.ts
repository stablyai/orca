import type { PtyIpcSurface } from './pty-host-bindings'
import {
  handleMock,
  onMock,
  removeAllListenersMock,
  removeHandlerMock
} from './pty-ipc-mock-registry'

/**
 * The registration surface pty suites drive. Production injects Electron's `ipcMain`;
 * suites inject this so the existing `handlers` map keeps capturing registrations
 * exactly as it did when the module imported `ipcMain` directly.
 */
export function testPtyIpcSurface(): PtyIpcSurface {
  return {
    handle: handleMock as unknown as PtyIpcSurface['handle'],
    on: onMock as unknown as PtyIpcSurface['on'],
    removeHandler: removeHandlerMock,
    removeAllListeners: removeAllListenersMock
  }
}
