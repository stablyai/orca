import type { PtyIpcSurface } from './pty/pty-host-bindings'
import {
  handleMock,
  onMock,
  removeAllListenersMock,
  removeHandlerMock
} from './pty-ipc-mock-registry'

/** Inject the same registration map used by split PTY suites. */
export function testPtyIpcSurface(): PtyIpcSurface {
  return {
    handle: handleMock as unknown as PtyIpcSurface['handle'],
    on: onMock as unknown as PtyIpcSurface['on'],
    removeHandler: removeHandlerMock,
    removeAllListeners: removeAllListenersMock
  }
}
