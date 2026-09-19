import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isMacosTahoeOrNewer } from '../window/macos-tahoe-release'

const HELPER_EXECUTABLE = 'orca-speech-transcriber'

let cachedHelperPath: string | null | undefined

/** Contents/MacOS, beside the app binary — SpeechAnalyzer keys asset installs to the bundle. */
export function getAppleSpeechHelperPath(): string | null {
  if (cachedHelperPath !== undefined) {
    return cachedHelperPath
  }
  if (process.platform !== 'darwin') {
    cachedHelperPath = null
    return cachedHelperPath
  }
  const candidate = join(dirname(process.execPath), HELPER_EXECUTABLE)
  cachedHelperPath = existsSync(candidate) ? candidate : null
  return cachedHelperPath
}

export function resetAppleSpeechHelperPathCache(): void {
  cachedHelperPath = undefined
}

/**
 * The helper is built by swiftc, so a Mac without it (or one below macOS 26)
 * must not be offered the model at all.
 */
export function isAppleSpeechDictationAvailable(): boolean {
  return (
    process.platform === 'darwin' && isMacosTahoeOrNewer() && getAppleSpeechHelperPath() !== null
  )
}
