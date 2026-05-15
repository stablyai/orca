import { ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import { promisify } from 'node:util'
import {
  formatExternalEditorOpenTarget,
  type ExternalEditorOpenRequest
} from '../../shared/external-editor'
import { resolveCliCommand } from '../codex-cli/command'
import type { Store } from '../persistence'

const execFileAsync = promisify(execFile)

const ALLOWED_EXTERNAL_EDITOR_URL_SCHEMES = new Set([
  'vscode:',
  'vscode-insiders:',
  'cursor:',
  'windsurf:'
])

async function validateLocalFileTarget(pathValue: string): Promise<string | null> {
  const normalizedPath = normalize(pathValue)
  if (!isAbsolute(normalizedPath)) {
    return null
  }
  try {
    return (await stat(normalizedPath)).isFile() ? normalizedPath : null
  } catch {
    return null
  }
}

function isExternalEditorOpenRequest(value: unknown): value is ExternalEditorOpenRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const request = value as Record<string, unknown>
  return (
    typeof request.filePath === 'string' &&
    (request.line === undefined || request.line === null || typeof request.line === 'number') &&
    (request.column === undefined || request.column === null || typeof request.column === 'number')
  )
}

async function openExternalEditorForFileLink(
  store: Store | undefined,
  request: ExternalEditorOpenRequest
): Promise<boolean> {
  const filePath = await validateLocalFileTarget(request.filePath)
  if (!store || !filePath) {
    return false
  }

  const settings = store.getSettings()
  if (settings.fileLinkOpenTarget !== 'external-editor') {
    return false
  }

  const target = formatExternalEditorOpenTarget(settings.externalEditor, {
    ...request,
    filePath
  })
  if (!target) {
    return false
  }

  try {
    if (target.kind === 'url') {
      const parsed = new URL(target.url)
      if (!ALLOWED_EXTERNAL_EDITOR_URL_SCHEMES.has(parsed.protocol)) {
        return false
      }
      await shell.openExternal(parsed.toString())
      return true
    }

    const command = resolveCliCommand(target.command)
    await execFileAsync(command, target.args, {
      windowsHide: true,
      timeout: 10_000
    })
    return true
  } catch {
    return false
  }
}

export function registerExternalEditorFileLinkHandler(store?: Store): void {
  ipcMain.handle('shell:openExternalEditor', async (_event, args: unknown): Promise<boolean> => {
    // Why: the renderer only supplies the file/position; main derives argv/URL
    // from persisted settings so a compromised view cannot smuggle launch args.
    if (!isExternalEditorOpenRequest(args)) {
      return false
    }
    return openExternalEditorForFileLink(store, args)
  })
}
