import fs from 'node:fs'
import path from 'node:path'
import { isMacosTahoeOrNewer } from '../window/macos-tahoe-release'

export function getMacosSpeechHelperPath(): string | null {
  if (process.platform !== 'darwin' || !isMacosTahoeOrNewer()) {
    return null
  }
  const helper = path.join(path.dirname(process.execPath), 'orca-speech')
  return fs.existsSync(helper) ? helper : null
}
