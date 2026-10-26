import type {
  DesktopAppAgentActivity,
  DesktopAppAgentBlock,
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
  onAgentActivity: (callback: (activity: DesktopAppAgentActivity) => void) => () => void
  // Rejects later computer-use actions on this app until allowAgent.
  stopAgent: (args: DesktopAppAgentBlock) => Promise<void>
  allowAgent: (args: { pid: number }) => Promise<void>
  // Whether main still blocks agent actions on this pid, so a remounted pane can show Allow again.
  isAgentBlocked: (args: { pid: number }) => Promise<boolean>
}
