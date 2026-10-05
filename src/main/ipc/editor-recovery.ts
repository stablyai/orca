import { BrowserWindow, dialog, ipcMain } from 'electron'
import { basename, extname } from 'node:path'
import { z } from 'zod'
import { editorRecoveryChangeSchema } from '../../shared/editor-recovery'
import type { EditorRecoveryService } from '../editor-recovery/editor-recovery-service'
import { translateMain } from '../i18n/main-i18n'

export function registerEditorRecoveryHandlers(service: EditorRecoveryService): void {
  ipcMain.handle('editor-recovery:list', async () => (await service.ready()).list())
  ipcMain.handle('editor-recovery:read', async (_event, id: unknown) =>
    (await service.ready()).read(z.string().parse(id))
  )
  ipcMain.handle('editor-recovery:apply', async (_event, changes: unknown) =>
    (await service.ready()).apply(z.array(editorRecoveryChangeSchema).parse(changes))
  )
  ipcMain.handle('editor-recovery:export', async (event, args: unknown) => {
    const { id, revision } = z
      .object({ id: z.string(), revision: z.number().int().positive() })
      .parse(args)
    const worker = await service.ready()
    const draft = await worker.read(id)
    if (!draft || draft.revision !== revision) {
      throw new Error('The recovery draft changed. Refresh and retry.')
    }
    const name = basename(draft.filePath.replaceAll('\\', '/'))
    const extension = extname(name)
    const options = {
      title: translateMain('editorRecovery.saveTitle', 'Recover unsaved changes to a new file'),
      defaultPath: `${name.slice(0, name.length - extension.length)}.recovered${extension}`
    }
    const parent = BrowserWindow.fromWebContents(event.sender)
    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) {
      return null
    }
    return worker.export(id, revision, result.filePath)
  })
}
