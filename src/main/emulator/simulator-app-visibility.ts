import { execFile } from 'node:child_process'
import { platform } from 'node:os'

export async function hideNativeSimulatorApp(): Promise<void> {
  if (platform() !== 'darwin') {
    return
  }

  await new Promise<void>((resolve) => {
    // Why: Simulator.app does not expose a direct hide command, but System Events
    // can hide the process after CoreSimulator/serve-sim surfaces a native window.
    execFile(
      'osascript',
      [
        '-e',
        'tell application "System Events"',
        '-e',
        'if exists application process "Simulator" then set visible of application process "Simulator" to false',
        '-e',
        'end tell'
      ],
      { timeout: 2_000 },
      () => {
        resolve()
      }
    )
  })
}
