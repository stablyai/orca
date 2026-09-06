import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron'
import { posix } from 'node:path'
import {
  WORKSPACE_WINDOW_METADATA_CHANNEL,
  type WorkspaceWindowMetadata
} from '../../shared/workspace-window-metadata'

const MAX_WORKSPACE_DISPLAY_NAME_LENGTH = 512
const MAX_REPRESENTED_PATH_LENGTH = 32_768

function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed && trimmed.length <= MAX_WORKSPACE_DISPLAY_NAME_LENGTH ? trimmed : null
}

function normalizeLocalPath(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_REPRESENTED_PATH_LENGTH ||
    value.includes('\0') ||
    !posix.isAbsolute(value)
  ) {
    return null
  }
  return value
}

export function normalizeWorkspaceWindowMetadata(value: unknown): WorkspaceWindowMetadata {
  if (!value || typeof value !== 'object') {
    return { displayName: null, localPath: null }
  }
  const candidate = value as Record<string, unknown>
  return {
    displayName: normalizeDisplayName(candidate.displayName),
    localPath: normalizeLocalPath(candidate.localPath)
  }
}

export function installWorkspaceWindowMetadataListener(
  window: BrowserWindow,
  baseWindowTitle: string,
  platform: NodeJS.Platform = process.platform
): () => void {
  if (platform !== 'darwin') {
    return () => {}
  }

  const rendererWebContentsId = window.webContents.id
  const onWorkspaceWindowMetadata = (event: IpcMainEvent, value: unknown): void => {
    if (event.sender.id !== rendererWebContentsId || window.isDestroyed()) {
      return
    }
    const metadata = normalizeWorkspaceWindowMetadata(value)
    // Why: representedFilename becomes macOS AXDocument, while the title gives
    // time trackers a useful fallback without making remote paths look local.
    window.setRepresentedFilename(metadata.localPath ?? '')
    window.setTitle(
      metadata.displayName ? `${metadata.displayName} — ${baseWindowTitle}` : baseWindowTitle
    )
  }

  ipcMain.on(WORKSPACE_WINDOW_METADATA_CHANNEL, onWorkspaceWindowMetadata)
  return () => {
    ipcMain.removeListener(WORKSPACE_WINDOW_METADATA_CHANNEL, onWorkspaceWindowMetadata)
  }
}
