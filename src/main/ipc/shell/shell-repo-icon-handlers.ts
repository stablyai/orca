import { BrowserWindow, ipcMain } from 'electron'
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { translateMain } from '../../i18n/main-i18n'
import {
  MAX_REPO_ICON_INPUT_BYTES,
  MAX_REPO_ICON_UPLOAD_BYTES
} from '../../../shared/repository/appearance/repo-icon'
import { repoIconPickFailure } from '../../../shared/repository/appearance/repo-icon-pick-failure-copy'
import type {
  RepoIconPickResult,
  RepoIconPreviewResult
} from '../../../shared/repository/appearance/repo-icon-pick-result'
import { showSingleFlightOpenDialog } from '../dialogs/single-flight-open-dialog'
import {
  readDirectRepoIconPng,
  readRepoIconPreview,
  REPO_ICON_INPUT_LIMIT_LABEL
} from '../../repository-icons/repo-icon-pick-image'
import {
  rememberRepoIconSelection,
  resolveRepoIconSelection
} from '../../repository-icons/repo-icon-pick-selection-store'

export function registerShellRepoIconHandlers(): void {
  ipcMain.handle('shell:pickRepoIconImage', async (event): Promise<RepoIconPickResult> => {
    const result = await showSingleFlightOpenDialog(
      {
        properties: ['openFile'],
        filters: [
          {
            name: translateMain('native.dialog.repoIconImages', 'Repo icon images'),
            extensions: ['png', 'jpg', 'jpeg']
          }
        ]
      },
      BrowserWindow.fromWebContents(event.sender)
    )
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const filePath = result.filePaths[0]
    const extension = extname(filePath).toLowerCase()
    const originalMimeType =
      extension === '.png'
        ? 'image/png'
        : extension === '.jpg' || extension === '.jpeg'
          ? 'image/jpeg'
          : null
    if (!originalMimeType) {
      return repoIconPickFailure('notPng')
    }

    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(filePath)
    } catch {
      return repoIconPickFailure('invalidImage')
    }
    if (!info.isFile() || info.size <= 0) {
      return repoIconPickFailure('invalidImage')
    }
    if (info.size > MAX_REPO_ICON_INPUT_BYTES) {
      return repoIconPickFailure('tooLarge', { limit: REPO_ICON_INPUT_LIMIT_LABEL })
    }

    if (originalMimeType === 'image/png' && info.size <= MAX_REPO_ICON_UPLOAD_BYTES) {
      return readDirectRepoIconPng(filePath)
    }

    return rememberRepoIconSelection(event.sender, {
      filePath,
      fileName: basename(filePath),
      originalBytes: info.size,
      originalMimeType
    })
  })

  ipcMain.handle(
    'shell:previewRepoIconImage',
    async (event, token: unknown): Promise<RepoIconPreviewResult> => {
      if (typeof token !== 'string' || token.length === 0) {
        return repoIconPickFailure('invalidImage')
      }
      const selection = resolveRepoIconSelection(event.sender, token)
      return selection
        ? readRepoIconPreview(selection.filePath)
        : repoIconPickFailure('invalidImage')
    }
  )
}
