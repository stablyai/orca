import { shell, dialog } from 'electron'
import {
  createWorkspaceWindowShellScope,
  registerWorkspaceWindowShellHandler as handle
} from '../window/workspace-window-shell-routing'
import type { ShellPathScope, ShellRuntimeScope } from '../../preload/api/shell-api'
import { constants, copyFile, readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, normalize, posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ShellOpenExternalEditorRequest,
  ShellOpenExternalEditorResult,
  ShellOpenLocalPathResult
} from '../../shared/shell-open-types'
import { MAX_REPO_ICON_UPLOAD_BYTES } from '../../shared/repo-icon'
import type { Store } from '../persistence'
import {
  EXTERNAL_EDITOR_CLI_COMMAND,
  launchExternalEditor,
  resolveExternalEditorLaunchSpec,
  resolveVsCodeRemoteSshLaunchSpec
} from '../external-editor-launch'
import { resolveVsCodeSshAuthority } from '../ssh/vscode-ssh-authority'

export { EXTERNAL_EDITOR_CLI_COMMAND }

const REPO_ICON_IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png'
}

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

async function openInFileManager(
  pathValue: string,
  remoteRuntime: boolean
): Promise<ShellOpenLocalPathResult> {
  if (remoteRuntime) {
    return { ok: false, reason: 'remote-runtime-unsupported' }
  }
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

async function openInExternalEditor(
  store: Store,
  request: ShellOpenExternalEditorRequest,
  remoteRuntime: boolean
): Promise<ShellOpenExternalEditorResult> {
  if (remoteRuntime) {
    return { ok: false, reason: 'remote-runtime-unsupported' }
  }

  const connectionId = request.connectionId?.trim()
  if (connectionId) {
    const sshTarget = store.getSshTarget(connectionId)
    if (!sshTarget) {
      return { ok: false, reason: 'ssh-target-not-found' }
    }
    if (sshTarget.owner?.type === 'on-demand-runtime') {
      return { ok: false, reason: 'remote-runtime-unsupported' }
    }
    if (!posix.isAbsolute(request.path) && !win32.isAbsolute(request.path)) {
      return { ok: false, reason: 'not-absolute' }
    }
    const authority = resolveVsCodeSshAuthority(sshTarget)
    if (!authority.ok) {
      return authority
    }
    const launchSpec = resolveVsCodeRemoteSshLaunchSpec(
      request.command,
      request.path,
      authority.authority
    )
    if (!launchSpec) {
      return { ok: false, reason: 'remote-editor-unsupported' }
    }
    try {
      await launchExternalEditor(launchSpec)
      return { ok: true }
    } catch {
      return { ok: false, reason: 'launch-failed' }
    }
  }

  const target = await validateLocalPathTarget(request.path)
  if (!target.ok) {
    return target
  }
  try {
    await launchExternalEditor(resolveExternalEditorLaunchSpec(request.command, target.path))
    return { ok: true }
  } catch {
    return { ok: false, reason: 'launch-failed' }
  }
}

async function openWithSystemDefault(pathValue: string): Promise<boolean> {
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
  store: Store,
  getRuntimeId: () => string | null = () => null
): void {
  const { remoteRuntime, remotePath } = createWorkspaceWindowShellScope(store, getRuntimeId)
  handle(
    'shell:openPath',
    async (_event, path: string, runtimeId?: ShellRuntimeScope): Promise<void> => {
      // Why: keep the legacy fire-and-forget renderer contract while reusing the
      // same absolute/existing path validation as the explicit file-manager API.
      void (await openInFileManager(path, remoteRuntime(runtimeId)))
    }
  )

  handle(
    'shell:openInFileManager',
    (_event, path: string, runtimeId?: ShellRuntimeScope): Promise<ShellOpenLocalPathResult> =>
      openInFileManager(path, remoteRuntime(runtimeId))
  )

  handle(
    'shell:openInExternalEditor',
    (
      _event,
      request: ShellOpenExternalEditorRequest,
      runtimeId?: ShellRuntimeScope
    ): Promise<ShellOpenExternalEditorResult> =>
      openInExternalEditor(store, request, remoteRuntime(runtimeId))
  )

  handle('shell:openUrl', (_event, rawUrl: string) => {
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

  handle(
    'shell:openFilePath',
    async (_event, filePath: string, scope?: ShellPathScope): Promise<boolean> => {
      if (remotePath(scope)) {
        return false
      }
      return openWithSystemDefault(filePath)
    }
  )

  handle('shell:openFileUri', async (_event, rawUri: string, scope?: ShellPathScope) => {
    if (remotePath(scope)) {
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

    await openWithSystemDefault(target.path)
  })

  handle(
    'shell:pathExists',
    async (_event, filePath: string, scope?: ShellPathScope): Promise<boolean> => {
      if (remotePath(scope)) {
        return false
      }
      return pathExists(filePath)
    }
  )

  handle(
    'shell:pickDirectory',
    async (_event, args: { defaultPath?: string }): Promise<string | null> => {
      const result = await dialog.showOpenDialog({
        defaultPath: args.defaultPath,
        // Why: callers only need an existing folder grant; enabling native
        // creation can leave typed prefix directories behind on macOS.
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return null
      }
      return result.filePaths[0]
    }
  )

  // Why: window.prompt() and <input type="file"> are unreliable in Electron,
  // so we use the native OS dialog to let the user pick any attachment file.
  handle('shell:pickAttachment', async (): Promise<string | null> => {
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
  handle('shell:pickImage', async (): Promise<string | null> => {
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

  handle(
    'shell:pickRepoIconImage',
    async (): Promise<{ dataUrl: string; fileName: string } | null> => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Repo icon images', extensions: ['png'] }]
      })
      if (result.canceled || result.filePaths.length === 0) {
        return null
      }

      const filePath = result.filePaths[0]
      const extension = extname(filePath).toLowerCase()
      const mimeType = REPO_ICON_IMAGE_MIME_TYPES[extension]
      if (!mimeType) {
        throw new Error('Repo icons must be PNG files.')
      }

      const stats = await stat(filePath)
      if (stats.size > MAX_REPO_ICON_UPLOAD_BYTES) {
        throw new Error('Repo icon image must be 256KB or smaller.')
      }

      const buffer = await readFile(filePath)
      return {
        dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
        fileName: basename(filePath)
      }
    }
  )

  handle('shell:pickAudio', async (): Promise<string | null> => {
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
  handle(
    'shell:copyFile',
    async (
      _event,
      args: { srcPath: string; destPath: string },
      scope?: ShellPathScope
    ): Promise<void> => {
      if (remotePath(scope)) {
        throw new Error('remote-runtime-unsupported')
      }
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
