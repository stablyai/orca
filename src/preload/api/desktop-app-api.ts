import type {
  DesktopAppCaptureSource,
  DesktopAppInput,
  DesktopAppInputResult,
  DesktopAppTarget,
  DesktopAppWindow
} from '../../shared/desktop-app-types'

export type DesktopAppApi = {
  listWindows: () => Promise<DesktopAppWindow[]>
  // Arms the window as the source for the caller's next navigator.mediaDevices.getDisplayMedia().
  prepareCapture: (args: DesktopAppTarget) => Promise<DesktopAppCaptureSource>
  // Undoes one prepareCapture; input to the window stops once no pane shows it.
  releaseCapture: (args: DesktopAppTarget) => Promise<void>
  sendInput: (args: DesktopAppTarget & { input: DesktopAppInput }) => Promise<DesktopAppInputResult>
}
