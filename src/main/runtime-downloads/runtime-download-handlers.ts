import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import {
  RUNTIME_OPEN_LOCALLY_MAX_BYTES,
  type RuntimeDownloadProgressEvent,
  type RuntimeDownloadResult,
  type RuntimeDownloadStartArgs
} from '../../shared/runtime-downloads/runtime-download-contract'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
import { getRuntimeEnvironmentRegistryRoot } from '../ipc/runtime-environments/runtime-environment-registry-root'
import { sanitizeLocalDownloadFilename } from '../ipc/filesystem/local-download-filename'
import {
  cleanupLocalTransferPath,
  createSiblingTransferPath,
  inspectDownloadDestination,
  promoteDownloadedFile
} from '../ipc/filesystem/filesystem-download-promotion'
import { abortWhenRendererGone } from '../ipc/renderer-lifetime-abort'
import {
  RuntimeDownloadError,
  transferRuntimeFile,
  transferRuntimeFolder,
  type RuntimeDownloadCall,
  type RuntimeDownloadProgress
} from './runtime-download-transfer'
import { runtimeDownloadErrorFromResponse, toRuntimeDownloadError } from './runtime-download-errors'
import {
  createRuntimeOpenLocalDirectory,
  pruneRuntimeOpenLocalCache
} from './runtime-open-local-cache'

export const RUNTIME_DOWNLOAD_PROGRESS_CHANNEL = 'runtimeDownloads:progress'
// A toast cannot show finer progress than this, and every event crosses IPC.
const PROGRESS_INTERVAL_MS = 120
const MAX_ACTIVE_DOWNLOADS = 8

const activeDownloads = new Map<string, AbortController>()

function validateArgs(args: unknown): RuntimeDownloadStartArgs {
  const value = args as Partial<RuntimeDownloadStartArgs> | null
  const isText = (field: unknown, allowEmpty = false): field is string =>
    typeof field === 'string' && (allowEmpty || field.trim() !== '') && field.length <= 4096
  if (
    !value ||
    !isText(value.downloadId) ||
    !isText(value.environmentId) ||
    !isText(value.worktree) ||
    !isText(value.relativePath, true) ||
    !isText(value.name) ||
    (value.kind !== 'file' && value.kind !== 'folder') ||
    (value.intent !== 'save' && value.intent !== 'open')
  ) {
    throw new Error('Invalid runtime download request')
  }
  if (value.intent === 'open' && value.kind !== 'file') {
    throw new Error('Only files can be opened locally')
  }
  return value as RuntimeDownloadStartArgs
}

function createCall(args: RuntimeDownloadStartArgs): RuntimeDownloadCall {
  return async <T>(
    method: string,
    params: unknown,
    options: { timeoutMs: number; signal: AbortSignal }
  ): Promise<T> => {
    const response = await callRuntimeEnvironment(
      getRuntimeEnvironmentRegistryRoot(),
      args.environmentId,
      method,
      params,
      options.timeoutMs,
      args.expectedEnvironmentPairingRevision,
      undefined,
      { signal: options.signal, lane: 'download' }
    )
    if (!response.ok) {
      throw runtimeDownloadErrorFromResponse(response.error)
    }
    return response.result as T
  }
}

function createProgressEmitter(sender: WebContents, downloadId: string) {
  let lastSentAt = 0
  let destinationPath: string | undefined
  const send = (event: Omit<RuntimeDownloadProgressEvent, 'downloadId' | 'destinationPath'>) => {
    if (!sender.isDestroyed()) {
      sender.send(RUNTIME_DOWNLOAD_PROGRESS_CHANNEL, {
        downloadId,
        ...event,
        ...(destinationPath ? { destinationPath } : {})
      } satisfies RuntimeDownloadProgressEvent)
    }
  }
  return {
    setDestination(path: string) {
      destinationPath = path
    },
    preparing() {
      send({ phase: 'preparing', receivedBytes: 0, totalBytes: null, processedBytes: 0 })
    },
    progress(progress: RuntimeDownloadProgress) {
      const now = Date.now()
      if (now - lastSentAt < PROGRESS_INTERVAL_MS) {
        return
      }
      lastSentAt = now
      send({ phase: 'transferring', ...progress })
    }
  }
}

async function chooseDestination(
  sender: WebContents,
  args: RuntimeDownloadStartArgs
): Promise<string | null> {
  const baseName = sanitizeLocalDownloadFilename(args.name)
  if (args.intent === 'open') {
    void pruneRuntimeOpenLocalCache()
    return join(await createRuntimeOpenLocalDirectory(), baseName)
  }
  const suggestedName = args.kind === 'folder' ? `${baseName}.zip` : baseName
  const parentWindow = BrowserWindow.fromWebContents(sender) ?? undefined
  const options: Electron.SaveDialogOptions = {
    defaultPath: join(app.getPath('downloads'), suggestedName),
    ...(args.kind === 'folder' ? { filters: [{ name: 'ZIP archive', extensions: ['zip'] }] } : {})
  }
  const result = parentWindow
    ? await dialog.showSaveDialog(parentWindow, options)
    : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
}

async function runDownload(
  sender: WebContents,
  args: RuntimeDownloadStartArgs,
  controller: AbortController
): Promise<RuntimeDownloadResult> {
  const destinationPath = await chooseDestination(sender, args)
  if (!destinationPath || controller.signal.aborted) {
    return { status: 'canceled' }
  }
  const emitter = createProgressEmitter(sender, args.downloadId)
  emitter.setDestination(destinationPath)
  emitter.preparing()
  const { existed } = await inspectDownloadDestination(destinationPath)
  const tempPath = createSiblingTransferPath(destinationPath, 'download')
  const sink = await open(tempPath, 'wx')
  let promoted = false
  try {
    const transferInput = {
      call: createCall(args),
      worktree: args.worktree,
      relativePath: args.relativePath,
      sink,
      signal: controller.signal,
      onProgress: (progress: RuntimeDownloadProgress) => emitter.progress(progress)
    }
    const outcome =
      args.kind === 'folder'
        ? await transferRuntimeFolder({
            ...transferInput,
            excludeDefaultDirs: args.excludeDefaultDirs !== false
          })
        : await transferRuntimeFile({
            ...transferInput,
            ...(args.intent === 'open' ? { maxBytes: RUNTIME_OPEN_LOCALLY_MAX_BYTES } : {})
          })
    await sink.close()
    if (controller.signal.aborted) {
      throw new RuntimeDownloadError('canceled')
    }
    await promoteDownloadedFile(tempPath, destinationPath, existed)
    promoted = true
    let openError: string | undefined
    if (args.intent === 'open') {
      const message = await shell.openPath(destinationPath)
      openError = message === '' ? undefined : message
    }
    return {
      status: 'done',
      destinationPath,
      ...outcome,
      ...(openError ? { openError } : {})
    }
  } finally {
    await sink.close().catch(() => {})
    if (!promoted) {
      await cleanupLocalTransferPath(tempPath)
    }
  }
}

export function registerRuntimeDownloadHandlers(): void {
  ipcMain.handle(
    'runtimeDownloads:start',
    async (event, rawArgs: unknown): Promise<RuntimeDownloadResult> => {
      const args = validateArgs(rawArgs)
      if (activeDownloads.has(args.downloadId)) {
        throw new Error('Download already running')
      }
      if (activeDownloads.size >= MAX_ACTIVE_DOWNLOADS) {
        return {
          status: 'error',
          code: 'host_busy',
          message: 'Too many downloads are running; wait for one to finish.'
        }
      }
      const controller = new AbortController()
      activeDownloads.set(args.downloadId, controller)
      // Closing the window must not leave a transfer running nobody can cancel.
      const lifetime = abortWhenRendererGone(event.sender)
      const onGone = () => controller.abort()
      lifetime.signal.addEventListener('abort', onGone, { once: true })
      try {
        return await runDownload(event.sender, args, controller)
      } catch (error) {
        const failure = toRuntimeDownloadError(error, controller.signal)
        return failure.code === 'canceled'
          ? { status: 'canceled' }
          : { status: 'error', code: failure.code, message: failure.message }
      } finally {
        lifetime.signal.removeEventListener('abort', onGone)
        lifetime.dispose()
        activeDownloads.delete(args.downloadId)
      }
    }
  )

  ipcMain.handle('runtimeDownloads:cancel', (_event, args: { downloadId?: unknown }) => {
    const controller =
      typeof args?.downloadId === 'string' ? activeDownloads.get(args.downloadId) : undefined
    controller?.abort()
    return { canceled: controller !== undefined }
  })
}
