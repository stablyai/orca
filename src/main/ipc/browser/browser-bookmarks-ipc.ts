import { ipcMain } from 'electron'
import {
  browserBookmarkMutationSchema,
  browserBookmarkScopeSchema
} from '../../../shared/browser/bookmarks/browser-bookmarks'
import { getBrowserBookmarkStore } from '../../browser/bookmarks/browser-bookmark-profile'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

export function registerBrowserBookmarkHandlers(): void {
  ipcMain.removeHandler('browser:bookmarks:list')
  ipcMain.removeHandler('browser:bookmarks:mutate')
  ipcMain.handle('browser:bookmarks:list', (event) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      throw new Error('Untrusted browser bookmark request')
    }
    return getBrowserBookmarkStore().list()
  })
  ipcMain.handle('browser:bookmarks:mutate', async (event, scope: unknown, mutation: unknown) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      throw new Error('Untrusted browser bookmark request')
    }
    const store = getBrowserBookmarkStore()
    const result = await store.mutate(
      browserBookmarkScopeSchema.parse(scope),
      browserBookmarkMutationSchema.parse(mutation)
    )
    if (result === 'saved') {
      const bookmarks = await store.list()
      if (!event.sender.isDestroyed()) {
        event.sender.send('browser:bookmarks:changed', bookmarks)
      }
    }
    return result
  })
}
