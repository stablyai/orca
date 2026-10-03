import { ipcMain } from 'electron'
import {
  parseNativeChatDraft,
  type NativeChatDraftStoreResult,
  type SavedNativeChatDraft
} from '../../shared/native-chat-draft-record'
import {
  createNativeChatDraftStore,
  type NativeChatDraftStore
} from '../native-chat/native-chat-draft-store'
import { isTrustedUIRenderer } from './ui'

// Why one per root: macOS keeps the app alive with no window, and a reopened window must find the
// same store, with its failed writes still owed, rather than a second one reading the files anew.
const stores = new Map<string, NativeChatDraftStore>()

/** Drafts are the app window's own; no other renderer may read or write them. */
export function registerNativeChatDraftHandlers(root: string): void {
  const drafts = stores.get(root) ?? createNativeChatDraftStore(root)
  stores.set(root, drafts)
  ipcMain.removeHandler('nativeChat:drafts:load')
  ipcMain.removeHandler('nativeChat:drafts:write')
  ipcMain.removeAllListeners('nativeChat:drafts:loadSync')
  ipcMain.handle(
    'nativeChat:drafts:load',
    (event): Promise<SavedNativeChatDraft[]> | SavedNativeChatDraft[] =>
      isTrustedUIRenderer(event.sender) ? drafts.load() : []
  )
  ipcMain.on('nativeChat:drafts:loadSync', (event) => {
    event.returnValue = isTrustedUIRenderer(event.sender) ? drafts.loadSync() : []
  })
  ipcMain.handle(
    'nativeChat:drafts:write',
    (event, args: unknown): Promise<NativeChatDraftStoreResult> | NativeChatDraftStoreResult => {
      if (!isTrustedUIRenderer(event.sender) || typeof args !== 'object' || args === null) {
        return 'failed'
      }
      const scopeKey = 'scopeKey' in args ? args.scopeKey : undefined
      if (typeof scopeKey !== 'string' || scopeKey === '') {
        return 'failed'
      }
      // A cleared draft is null; anything unreadable is treated as cleared, never written.
      return drafts.write(scopeKey, 'draft' in args ? parseNativeChatDraft(args.draft) : null)
    }
  )
}

/** Lets drafts written just before quitting land before the app exits. */
export async function drainNativeChatDrafts(): Promise<void> {
  await Promise.all(Array.from(stores.values(), (drafts) => drafts.drain()))
}
