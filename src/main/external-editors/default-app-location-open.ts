import { runProcess } from '@orca/process-host'
import { app, shell } from 'electron'
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { formatFileLinkLocation } from '../../shared/file-links/file-link-location'
import { isPositiveSafeInteger } from '../../shared/positive-safe-integer'
import type { RuntimeFileOpenPosition } from '../../shared/file-access/runtime-editor-file-open'

// Bundles whose app accepts `--goto path:line:column` on its command line.
const GOTO_CAPABLE_MAC_APPS = new Set([
  'Cursor.app',
  'Visual Studio Code.app',
  'Visual Studio Code - Insiders.app'
])

// Why: the location arrives over IPC, so check its shape rather than trust the type.
function isFileLocation(
  location: RuntimeFileOpenPosition | undefined
): location is RuntimeFileOpenPosition {
  return (
    isPositiveSafeInteger(location?.line) &&
    (location?.column === undefined || isPositiveSafeInteger(location.column))
  )
}

async function openInMacDefaultAppAtLocation(
  filePath: string,
  location: RuntimeFileOpenPosition
): Promise<boolean> {
  try {
    const { path: appPath } = await app.getApplicationInfoForProtocol(pathToFileURL(filePath).href)
    if (!GOTO_CAPABLE_MAC_APPS.has(posix.basename(appPath))) {
      return false
    }
    // Same `open -n -g` hand-off as the editor's CLI, minus its Node startup and `--env` forwarding.
    // The editor sees a desktop (non-Dock) open, so it reuses the file's window like a CLI open, and
    // the empty env keeps Orca's variables out while a cold start resolves the login-shell env.
    const result = await runProcess({
      program: '/usr/bin/open',
      args: [
        '-n',
        '-g',
        '-a',
        appPath,
        '--args',
        '--goto',
        formatFileLinkLocation({ pathText: filePath, line: location.line, column: location.column })
      ],
      env: {},
      timeoutMs: null
    })
    return result.code === 0
  } catch {
    return false
  }
}

/** `shell.openPath` that keeps the line when the file's macOS default app is a VS Code-family editor. */
export async function openPathInDefaultApp(
  filePath: string,
  location: RuntimeFileOpenPosition | undefined
): Promise<string> {
  if (
    process.platform === 'darwin' &&
    isFileLocation(location) &&
    (await openInMacDefaultAppAtLocation(filePath, location))
  ) {
    return ''
  }
  return shell.openPath(filePath)
}
