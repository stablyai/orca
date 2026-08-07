import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import { EmulatorError } from './emulator-errors'
import { mapSimctlError } from './simctl-simulator-devices'

// Sets the simulator device's pasteboard (not the host clipboard). The text is
// piped through stdin so it never appears in the process argv or in execFile
// error messages, which echo the command line.
export async function setIosSimulatorPasteboardText(udid: string, text: string): Promise<void> {
  if (platform() !== 'darwin') {
    throw new EmulatorError(
      'emulator_not_macos',
      'iOS Simulator requires macOS with Xcode Command Line Tools.'
    )
  }

  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      'xcrun',
      ['simctl', 'pbcopy', udid],
      {
        timeout: 15_000,
        // Why: pbcopy decodes stdin using the process locale; Electron launched
        // from Finder has no LANG, and the C locale turns UTF-8 Korean/emoji
        // bytes into MacRoman mojibake on the device pasteboard.
        env: { ...process.env, LC_ALL: 'en_US.UTF-8' }
      },
      (error, _stdout, stderr) => {
        if (error) {
          reject(mapSimctlError(error, stderr))
          return
        }
        resolve()
      }
    )
    // Why: if pbcopy exits early the pipe breaks; surfacing EPIPE here would
    // shadow the more actionable execFile error delivered to the callback.
    child.stdin?.on('error', () => {})
    child.stdin?.end(text, 'utf8')
  })
}
