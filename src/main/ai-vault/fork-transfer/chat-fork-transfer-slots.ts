import {
  CHAT_FORK_TRANSFER_MAX_SESSIONS,
  CHAT_FORK_TRANSFER_MAX_SESSIONS_TOTAL
} from '../../../shared/ai-vault/fork-transfer/chat-fork-transfer-limits'
import { ChatForkTransferError } from './chat-fork-transfer-ownership'

export type Timed = { owner: string; timer: ReturnType<typeof setTimeout> | null }

/** Refuses a new transfer once its caller, or the host as a whole, holds its cap. */
export function reserveChatForkSlot(held: Iterable<{ owner: string }>[], owner: string): void {
  let total = 0
  let mine = 0
  for (const entries of held) {
    for (const entry of entries) {
      total += 1
      mine += entry.owner === owner ? 1 : 0
    }
  }
  if (mine >= CHAT_FORK_TRANSFER_MAX_SESSIONS || total >= CHAT_FORK_TRANSFER_MAX_SESSIONS_TOTAL) {
    throw new ChatForkTransferError('chat_fork_transfer_busy')
  }
}

export function ownedChatForkEntry<T extends Timed>(
  map: Map<string, T>,
  id: string,
  owner: string
): T {
  const entry = map.get(id)
  // Another caller's id reads as unknown, so ids never leak across devices.
  if (!entry || entry.owner !== owner) {
    throw new ChatForkTransferError('chat_fork_transfer_not_found')
  }
  return entry
}

export function restartChatForkIdleTimer(entry: Timed, idleMs: number, expire: () => void): void {
  clearChatForkIdleTimer(entry)
  entry.timer = setTimeout(expire, idleMs)
  entry.timer.unref?.()
}

export function clearChatForkIdleTimer(entry: Timed): void {
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
}
