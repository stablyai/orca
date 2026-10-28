import { app } from 'electron'
import { existsSync } from 'node:fs'
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { formatFileLinkLocation } from '../shared/file-link-location'
import type { ShellFileLocation } from '../shared/shell-open-types'
import { launchExternalEditor } from './external-editor-launch'

const MAC_EDITOR_COMMANDS: Record<string, string> = {
  'Cursor.app': 'cursor',
  'Visual Studio Code.app': 'code',
  'Visual Studio Code - Insiders.app': 'code'
}

export async function openDefaultEditorAtLocation(
  filePath: string,
  location: ShellFileLocation | undefined,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  if (
    platform !== 'darwin' ||
    !location ||
    !Number.isSafeInteger(location.line) ||
    location.line < 1 ||
    (location.column !== undefined &&
      (!Number.isSafeInteger(location.column) || location.column < 1))
  ) {
    return false
  }

  try {
    // Why: resolve this file's association, not whichever editor happens to be on PATH.
    const application = await app.getApplicationInfoForProtocol(pathToFileURL(filePath).href)
    const command = MAC_EDITOR_COMMANDS[posix.basename(application.path)]
    if (!command) {
      return false
    }
    const executable = posix.join(application.path, 'Contents', 'Resources', 'app', 'bin', command)
    if (!existsSync(executable)) {
      return false
    }
    await launchExternalEditor({
      kind: 'executable',
      hideWindowsConsole: true,
      spawnCmd: executable,
      spawnArgs: [
        '--goto',
        formatFileLinkLocation({
          pathText: filePath,
          line: location.line,
          column: location.column
        })
      ]
    })
    return true
  } catch {
    return false
  }
}
