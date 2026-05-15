import { ipcMain, shell, dialog } from 'electron'
import { spawn } from 'node:child_process'
import { constants, copyFile, stat } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ShellOpenLocalPathResult } from '../../shared/shell-open-types'
import { resolveCliCommand } from '../codex-cli/command'
import { getSpawnArgsForWindows } from '../win32-utils'

export const EXTERNAL_EDITOR_CLI_COMMAND = 'code'

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue)
    return true
  } catch {
    return false
  }
}

async function validateLocalPathTarget(
  pathValue: string
): Promise<{ ok: true; path: string } | { ok: false; reason: 'not-absolute' | 'not-found' }> {
  const normalizedPath = normalize(pathValue)
  if (!isAbsolute(normalizedPath)) {
    return { ok: false, reason: 'not-absolute' }
  }
  if (!(await pathExists(normalizedPath))) {
    return { ok: false, reason: 'not-found' }
  }
  return { ok: true, path: normalizedPath }
}

async function openInFileManager(pathValue: string): Promise<ShellOpenLocalPathResult> {
  const target = await validateLocalPathTarget(pathValue)
  if (!target.ok) {
    return target
  }
  try {
    // Why: the file-manager action uses reveal semantics, matching the
    // previous sidebar behavior while still validating the path per click.
    shell.showItemInFolder(target.path)
    return { ok: true }
  } catch {
    return { ok: false, reason: 'launch-failed' }
  }
}

async function launchExternalEditor(pathValue: string): Promise<void> {
  const editorCommand = resolveCliCommand(EXTERNAL_EDITOR_CLI_COMMAND)
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(editorCommand, [pathValue])

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(spawnCmd, spawnArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    let settled = false
    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      callback()
    }

    child.once('error', (error) => {
      settle(() => rejectPromise(error))
    })
    child.once('spawn', () => {
      child.unref()
      settle(resolvePromise)
    })
  })
}

async function openInExternalEditor(pathValue: string): Promise<ShellOpenLocalPathResult> {
  const target = await validateLocalPathTarget(pathValue)
  if (!target.ok) {
    return target
  }
  try {
    await launchExternalEditor(target.path)
    return { ok: true }
  } catch {
    return { ok: false, reason: 'launch-failed' }
  }
}

export function registerShellHandlers(): void {
  ipcMain.handle('shell:openPath', (_event, path: string) => {
    shell.showItemInFolder(path)
  })

  ipcMain.handle(
    'shell:openInFileManager',
    (_event, path: string): Promise<ShellOpenLocalPathResult> => openInFileManager(path)
  )

  ipcMain.handle(
    'shell:openInExternalEditor',
    (_event, path: string): Promise<ShellOpenLocalPathResult> => openInExternalEditor(path)
  )

  ipcMain.handle('shell:openUrl', (_event, rawUrl: string) => {
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return
    }

    return shell.openExternal(parsed.toString())
  })

  ipcMain.handle('shell:openFilePath', async (_event, filePath: string) => {
    const target = await validateLocalPathTarget(filePath)
    if (!target.ok) {
      return
    }
    try {
      await shell.openPath(target.path)
    } catch {
      // Why: legacy file-open IPC is best-effort; callers already treat failure as a no-op.
    }
  })

  ipcMain.handle('shell:openFileUri', async (_event, rawUri: string) => {
    let parsed: URL
    try {
      parsed = new URL(rawUri)
    } catch {
      return
    }

    if (parsed.protocol !== 'file:') {
      return
    }

    // Only local files are supported. Remote hosts are intentionally rejected.
    if (parsed.hostname && parsed.hostname !== 'localhost') {
      return
    }

    let filePath: string
    try {
      filePath = fileURLToPath(parsed)
    } catch {
      return
    }

    const target = await validateLocalPathTarget(filePath)
    if (!target.ok) {
      return
    }

    try {
      await shell.openPath(target.path)
    } catch {
      // Why: legacy file-open IPC is best-effort; callers already treat failure as a no-op.
    }
  })

  ipcMain.handle('shell:pathExists', async (_event, filePath: string): Promise<boolean> => {
    return pathExists(filePath)
  })

  ipcMain.handle(
    'shell:pickDirectory',
    async (_event, args: { defaultPath?: string }): Promise<string | null> => {
      const result = await dialog.showOpenDialog({
        defaultPath: args.defaultPath,
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return null
      }
      return result.filePaths[0]
    }
  )

  // Why: window.prompt() and <input type="file"> are unreliable in Electron,
  // so we use the native OS dialog to let the user pick any attachment file.
  ipcMain.handle('shell:pickAttachment', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  // Why: window.prompt() and <input type="file"> are unreliable in Electron,
  // so we use the native OS dialog to let the user pick an image file.
  ipcMain.handle('shell:pickImage', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  ipcMain.handle('shell:pickAudio', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['ogg', 'mp3', 'wav', 'm4a', 'aac', 'flac'] }]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  // Why: copying a picked image next to the markdown file lets us insert a
  // relative path (e.g. `![](image.png)`) instead of embedding base64,
  // keeping markdown files small and portable.
  ipcMain.handle(
    'shell:copyFile',
    async (_event, args: { srcPath: string; destPath: string }): Promise<void> => {
      const src = normalize(args.srcPath)
      const dest = normalize(args.destPath)
      if (!isAbsolute(src) || !isAbsolute(dest)) {
        throw new Error('Both source and destination must be absolute paths')
      }
      // Why: COPYFILE_EXCL prevents silently overwriting an existing file.
      // The renderer-side deconfliction loop already picks a unique name, so
      // the dest should never exist — if it does, something is wrong and we
      // should fail loudly rather than clobber data.
      await copyFile(src, dest, constants.COPYFILE_EXCL)
    }
  )
}
