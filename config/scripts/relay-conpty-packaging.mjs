import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  isWindowsRelayPlatform,
  RELAY_WINDOWS_CONPTY_FILENAMES
} from '../../src/shared/relay-artifacts.ts'
import { materializeWindowsConpty, verifyConptyDirectory } from './build-windows-conpty.mjs'

export async function stageWindowsRelayConpty(platform, outputDir, options = {}) {
  if (!isWindowsRelayPlatform(platform)) {
    return
  }
  const arch = platform.slice('win32-'.length)
  const staging = mkdtempSync(join(outputDir, '.conpty-'))
  try {
    await materializeWindowsConpty(arch, staging, options)
    for (const filename of RELAY_WINDOWS_CONPTY_FILENAMES) {
      const source = filename === 'conpty-LICENSE.txt' ? 'LICENSE.txt' : filename
      copyFileSync(join(staging, source), join(outputDir, filename))
    }
    verifyConptyDirectory(outputDir, arch)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
