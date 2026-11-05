import { ipcMain } from 'electron'
import {
  RangedDocumentCancel,
  RangedDocumentId,
  RangedDocumentRead,
  type RangedFileDocumentLocalOpen
} from '../../../shared/ranged-file-document'
import { SshHostNotServedError } from '../../providers/ssh-host-not-served-error'
import { abortWhenRendererGone } from '../renderer-lifetime-abort'
import { resolveLocalFileRequestPath } from './access/local-file-access-resolution'
import { guardWslUncPathAccess } from '../../wsl/filesystem/wsl-unc-access-gate'
import { RangedFileDocuments } from './ranged-file-documents'
import type { FilesystemHandlerContext } from './filesystem-handler-context'

export function registerFilesystemRangedDocumentHandlers({
  store
}: FilesystemHandlerContext): void {
  const documents = new RangedFileDocuments()
  const lifetimes = new Map<number, ReturnType<typeof abortWhenRendererGone>>()
  ipcMain.handle('fs:rangeDocumentOpen', async (event, args: RangedFileDocumentLocalOpen) => {
    if (!args || typeof args.filePath !== 'string')
      throw new Error('range_document_invalid_request')
    if (args.connectionId) throw new SshHostNotServedError(args.connectionId)
    let lifetime = lifetimes.get(event.sender.id)
    if (!lifetime) {
      lifetime = abortWhenRendererGone(event.sender)
      lifetimes.set(event.sender.id, lifetime)
      const senderId = event.sender.id
      lifetime.signal.addEventListener(
        'abort',
        () => {
          lifetimes.delete(senderId)
          void documents.closeOwner(`renderer:${senderId}`)
        },
        { once: true }
      )
    }
    const signal = lifetime.signal
    return guardWslUncPathAccess(
      args.filePath,
      () =>
        documents.open(
          `renderer:${event.sender.id}`,
          () => resolveLocalFileRequestPath(args.filePath, args.access, store),
          signal
        ),
      { wake: args.wakeWslDistro === true }
    )
  })
  ipcMain.handle('fs:rangeDocumentRead', (event, args: unknown) =>
    documents.read(`renderer:${event.sender.id}`, RangedDocumentRead.parse(args))
  )
  ipcMain.handle('fs:rangeDocumentStatus', (event, args: unknown) =>
    documents.status(`renderer:${event.sender.id}`, RangedDocumentId.parse(args).id)
  )
  ipcMain.handle('fs:rangeDocumentReload', (event, args: unknown) =>
    documents.reload(`renderer:${event.sender.id}`, RangedDocumentId.parse(args).id)
  )
  ipcMain.handle('fs:rangeDocumentClose', async (event, args: unknown) => {
    await documents.close(`renderer:${event.sender.id}`, RangedDocumentId.parse(args).id)
  })
  ipcMain.handle('fs:rangeDocumentCancel', (event, args: unknown) => {
    const params = RangedDocumentCancel.parse(args)
    documents.cancel(`renderer:${event.sender.id}`, params.id, params.requestToken)
  })
}
