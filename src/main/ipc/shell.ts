import { translateMain } from '../i18n/main-i18n'
import { ipcMain, shell, dialog } from 'electron'
import { constants, copyFile, readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, normalize, posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ShellOpenExternalEditorRequest,
  ShellOpenExternalEditorResult,
  ShellOpenLocalPathResult
} from '../../shared/shell-open-types'
import { MAX_REPO_ICON_SOURCE_BYTES } from '../../shared/repo-icon'
import { IMAGE_FILE_MIME_TYPES } from '../../shared/image-file-extensions'
import {
  repoIconPickFailure,
  type RepoIconPickResult
} from '../../shared/repo-icon-pick-failure-copy'
import type { Store } from '../persistence'
import {
  EXTERNAL_EDITOR_CLI_COMMAND,
  launchExternalEditor,
  resolveExternalEditorLaunchSpec
} from '../external-editor-launch'
import { resolveRemoteSshEditorLaunchSpec } from '../remote-ssh-editor-launch'
import { toSshExecutionHostId } from '../../shared/execution-host'
import {
  isEditorSshHostForOwner,
  listAppRuntimeEnvironments,
  type ListRuntimeEnvironments
} from './shell-editor-ssh-host'
import {
  isLocallyOwned,
  resolveOwnedPathTarget,
  validateLocalPathTarget
} from './shell-owned-path-target'
import { registerShellPathExistenceHandlers } from './shell-path-existence-handlers'

export { EXTERNAL_EDITOR_CLI_COMMAND }

async function openInFileManager(
  pathValue: string,
  ownerHostId: unknown
): Promise<ShellOpenLocalPathResult> {
  const target = await resolveOwnedPathTarget(pathValue, ownerHostId)
  if (!target.ok) {
    return target
  }
  try {
    shell.showItemInFolder(target.path)
    return { ok: true }
  } catch {
    return { ok: false, reason: 'launch-failed' }
  }
}

async function openInExternalEditor(
  store: Pick<Store, 'getSshTarget'>,
  request: ShellOpenExternalEditorRequest,
  listRuntimeEnvironments: ListRuntimeEnvironments
): Promise<ShellOpenExternalEditorResult> {
  const connectionId = request.connectionId?.trim()
  if (connectionId) {
    const sshTarget = store.getSshTarget(connectionId)
    if (!sshTarget) {
      return request.ownerHostId === toSshExecutionHostId(connectionId)
        ? { ok: false, reason: 'ssh-target-not-found' }
        : { ok: false, reason: 'remote-runtime-unsupported' }
    }
    if (!isEditorSshHostForOwner(sshTarget, request.ownerHostId, listRuntimeEnvironments)) {
      return { ok: false, reason: 'remote-runtime-unsupported' }
    }
    if (sshTarget.owner?.type === 'on-demand-runtime') {
      return { ok: false, reason: 'remote-runtime-unsupported' }
    }
    if (!posix.isAbsolute(request.path) && !win32.isAbsolute(request.path)) {
      return { ok: false, reason: 'not-absolute' }
    }
    const remoteLaunch = resolveRemoteSshEditorLaunchSpec(request.command, request.path, sshTarget)
    if (!remoteLaunch.ok) {
      return remoteLaunch
    }
    try {
      await launchExternalEditor(remoteLaunch.launchSpec)
      return { ok: true }
    } catch {
      return { ok: false, reason: 'launch-failed' }
    }
  }

  const target = await resolveOwnedPathTarget(request.path, request.ownerHostId)
  if (!target.ok) {
    return target
  }
  try {
    // VS Code and Cursor derive --remote wsl+<distro> from UNC paths.
    await launchExternalEditor(resolveExternalEditorLaunchSpec(request.command, target.path))
    return { ok: true }
  } catch {
    return { ok: false, reason: 'launch-failed' }
  }
}

async function openWithSystemDefault(pathValue: string, ownerHostId: unknown): Promise<boolean> {
  if (!isLocallyOwned(ownerHostId)) {
    return false
  }
  const target = await validateLocalPathTarget(pathValue)
  if (!target.ok) {
    return false
  }
  try {
    const errorMessage = await shell.openPath(target.path)
    return errorMessage.length === 0
  } catch {
    return false
  }
}

export function registerShellHandlers(
  store: Pick<Store, 'getSshTarget'>,
  listRuntimeEnvironments: ListRuntimeEnvironments = listAppRuntimeEnvironments
): void {
  ipcMain.handle(
    'shell:openPath',
    async (_event, path: string, ownerHostId: unknown): Promise<void> => {
      // Preserve the legacy fire-and-forget contract while applying the common path validation.
      void (await openInFileManager(path, ownerHostId))
    }
  )

  ipcMain.handle(
    'shell:openInFileManager',
    (_event, path: string, ownerHostId: unknown): Promise<ShellOpenLocalPathResult> =>
      openInFileManager(path, ownerHostId)
  )

  ipcMain.handle(
    'shell:openInExternalEditor',
    (_event, request: ShellOpenExternalEditorRequest): Promise<ShellOpenExternalEditorResult> =>
      openInExternalEditor(store, request, listRuntimeEnvironments)
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

  ipcMain.handle(
    'shell:openFilePath',
    async (_event, filePath: string, ownerHostId: unknown): Promise<boolean> =>
      openWithSystemDefault(filePath, ownerHostId)
  )

  ipcMain.handle('shell:openFileUri', async (_event, rawUri: string, ownerHostId: unknown) => {
    if (!isLocallyOwned(ownerHostId)) {
      return
    }
    let parsed: URL
    try {
      parsed = new URL(rawUri)
    } catch {
      return
    }

    if (parsed.protocol !== 'file:') {
      return
    }

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

    await openWithSystemDefault(target.path, ownerHostId)
  })

  registerShellPathExistenceHandlers()

  ipcMain.handle(
    'shell:pickDirectory',
    async (_event, args: { defaultPath?: string }): Promise<string | null> => {
      const result = await dialog.showOpenDialog({
        defaultPath: args.defaultPath,
        // macOS creation-enabled pickers can create typed prefixes; this picker grants existing folders only.
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return null
      }
      return result.filePaths[0]
    }
  )

  // Native dialogs avoid Electron prompt/file-input reliability issues.
  ipcMain.handle('shell:pickAttachment', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  // Keep single-file callers, including interpreter selection, on pickAttachment.
  ipcMain.handle('shell:pickAttachments', async (): Promise<string[]> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections']
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('shell:pickImage', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        {
          name: translateMain('native.dialog.images', 'Images'),
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']
        }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  ipcMain.handle('shell:pickRepoIconImage', async (): Promise<RepoIconPickResult> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        {
          name: translateMain('native.dialog.repoIconImages', 'Repo icon images'),
          extensions: Object.keys(IMAGE_FILE_MIME_TYPES).map((extension) => extension.slice(1))
        }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const filePath = result.filePaths[0]
    const extension = extname(filePath).toLowerCase()
    const mimeType = IMAGE_FILE_MIME_TYPES[extension]
    if (!mimeType) {
      return repoIconPickFailure('unsupportedImage')
    }

    const stats = await stat(filePath)
    if (!stats.isFile() || stats.size > MAX_REPO_ICON_SOURCE_BYTES) {
      return repoIconPickFailure('sourceTooLarge')
    }

    const buffer = await readFile(filePath)
    return {
      dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
      fileName: basename(filePath)
    }
  })

  ipcMain.handle('shell:pickAudio', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        {
          name: translateMain('native.dialog.audio', 'Audio'),
          extensions: ['ogg', 'mp3', 'wav', 'm4a', 'aac', 'flac']
        }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  // Relative image links keep Markdown small and portable.
  ipcMain.handle(
    'shell:copyFile',
    async (_event, args: { srcPath: string; destPath: string }): Promise<void> => {
      const src = normalize(args.srcPath)
      const dest = normalize(args.destPath)
      if (!isAbsolute(src) || !isAbsolute(dest)) {
        throw new Error('Both source and destination must be absolute paths')
      }
      // Reject name collisions even if renderer deconfliction missed one; never overwrite existing data.
      await copyFile(src, dest, constants.COPYFILE_EXCL)
    }
  )
}
