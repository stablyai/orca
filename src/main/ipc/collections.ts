import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import type { Collection } from '../../shared/collection-types'
import type { Store } from '../persistence'

// Why: nonempty names match the runtime RPC contract (requiredString) so both
// transports reject '' instead of silently renaming to the fallback.
const CollectionCreateArgs = z.object({
  name: z.string().min(1),
  color: z.string().nullable().optional()
})

const CollectionUpdateArgs = z.object({
  collectionId: z.string().min(1),
  updates: z.object({
    name: z.string().min(1).optional(),
    color: z.string().nullable().optional(),
    isCollapsed: z.boolean().optional(),
    order: z.number().optional()
  })
})

const CollectionSelectorArgs = z.object({
  collectionId: z.string()
})

function parseCollectionIpcArgs<Schema extends z.ZodTypeAny>(
  schema: Schema,
  rawArgs: unknown,
  errorCode: string
): z.infer<Schema> {
  const parsed = schema.safeParse(rawArgs)
  if (!parsed.success) {
    throw new Error(errorCode)
  }
  return parsed.data
}

function notifyReposChanged(mainWindow: BrowserWindow): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('repos:changed')
  }
}

export function registerCollectionHandlers(mainWindow: BrowserWindow, store: Store): void {
  ipcMain.removeHandler('collections:list')
  ipcMain.removeHandler('collections:create')
  ipcMain.removeHandler('collections:update')
  ipcMain.removeHandler('collections:delete')

  ipcMain.handle('collections:list', () => store.getCollections())

  ipcMain.handle('collections:create', (_event, rawArgs: unknown): Collection => {
    const args = parseCollectionIpcArgs(
      CollectionCreateArgs,
      rawArgs,
      'invalid_collection_create_args'
    )
    const collection = store.createCollection(args)
    notifyReposChanged(mainWindow)
    return collection
  })

  ipcMain.handle('collections:update', (_event, rawArgs: unknown): Collection | null => {
    const args = parseCollectionIpcArgs(
      CollectionUpdateArgs,
      rawArgs,
      'invalid_collection_update_args'
    )
    const updated = store.updateCollection(args.collectionId, args.updates)
    if (updated) {
      notifyReposChanged(mainWindow)
    }
    return updated
  })

  ipcMain.handle('collections:delete', (_event, rawArgs: unknown): boolean => {
    const args = parseCollectionIpcArgs(
      CollectionSelectorArgs,
      rawArgs,
      'invalid_collection_delete_args'
    )
    const deleted = store.deleteCollection(args.collectionId)
    if (deleted) {
      notifyReposChanged(mainWindow)
    }
    return deleted
  })
}
