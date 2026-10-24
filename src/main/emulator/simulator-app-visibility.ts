import { execFile } from 'node:child_process'
import { platform } from 'node:os'

export async function hideNativeSimulatorApp(): Promise<void> {
  if (platform() !== 'darwin') {
    return
  }

  await new Promise<void>((resolve) => {
    // Simulator has no hide command; use System Events to hide the native process.
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
