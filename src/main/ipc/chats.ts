import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import type { Store } from '../persistence'
import type { WorktreeChat, WorktreeMeta } from '../../shared/types'
import { defaultChatId, isDefaultChatId } from '../../shared/chat-id'

function fallbackChat(worktreeId: string): WorktreeChat {
  return { id: defaultChatId(worktreeId), title: 'Chat 1', createdAt: 0, updatedAt: 0 }
}

function getChats(store: Store, worktreeId: string): WorktreeChat[] {
  return store.getWorktreeMeta(worktreeId)?.chats ?? [fallbackChat(worktreeId)]
}

function persistChats(store: Store, worktreeId: string, chats: WorktreeChat[]): WorktreeMeta {
  return store.setWorktreeMeta(worktreeId, { chats })
}

export function registerChatHandlers(store: Store): void {
  ipcMain.removeHandler('chat:list')
  ipcMain.removeHandler('chat:create')
  ipcMain.removeHandler('chat:remove')
  ipcMain.removeHandler('chat:rename')

  ipcMain.handle('chat:list', (_event, args: { worktreeId: string }) =>
    getChats(store, args.worktreeId)
  )

  ipcMain.handle('chat:create', (_event, args: { worktreeId: string; title?: string }) => {
    const now = Date.now()
    const existing = getChats(store, args.worktreeId)
    const chat: WorktreeChat = {
      id: `chat:${randomUUID()}`,
      title: args.title?.trim() || `Chat ${existing.length + 1}`,
      createdAt: now,
      updatedAt: now
    }
    persistChats(store, args.worktreeId, [...existing, chat])
    return chat
  })

  ipcMain.handle('chat:remove', (_event, args: { worktreeId: string; chatId: string }) => {
    const existing = getChats(store, args.worktreeId)
    if (existing.length <= 1 || isDefaultChatId(args.worktreeId, args.chatId)) {
      return existing
    }
    return (
      persistChats(
        store,
        args.worktreeId,
        existing.filter((chat) => chat.id !== args.chatId)
      ).chats ?? [fallbackChat(args.worktreeId)]
    )
  })

  ipcMain.handle(
    'chat:rename',
    (_event, args: { worktreeId: string; chatId: string; title: string }) => {
      const title = args.title.trim()
      if (!title) {
        return getChats(store, args.worktreeId)
      }
      return (
        persistChats(
          store,
          args.worktreeId,
          getChats(store, args.worktreeId).map((chat) =>
            chat.id === args.chatId ? { ...chat, title, updatedAt: Date.now() } : chat
          )
        ).chats ?? [fallbackChat(args.worktreeId)]
      )
    }
  )
}
