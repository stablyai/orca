import type { Event as WatcherEvent } from '@parcel/watcher'
import { toWslUncPath } from './filesystem-watcher-wsl-snapshot'

export type WslHostMessage =
  | { op: 'ready'; protocol?: unknown }
  | { op: 'subscribed'; id?: unknown }
  | { op: 'subscribe-failed'; id?: unknown; message?: unknown }
  | { op: 'events'; id?: unknown; events?: unknown }
  | { op: 'watch-error'; id?: unknown; message?: unknown; reason?: unknown }
  | { op: 'unsubscribed'; id?: unknown }
  | { op: 'protocol-error'; message?: unknown }

export function wslHostMessageEvents(
  message: WslHostMessage,
  context: { distro: string; linuxPath: string }
): WatcherEvent[] {
  if (message.op !== 'events' || !Array.isArray(message.events)) {
    return []
  }
  const root = context.linuxPath.replace(/\/+$/, '') || '/'
  const prefix = root === '/' ? '/' : `${root}/`
  const events: WatcherEvent[] = []
  for (const event of message.events) {
    const candidate = event as { type?: unknown; path?: unknown }
    if (
      (candidate.type === 'create' || candidate.type === 'update' || candidate.type === 'delete') &&
      typeof candidate.path === 'string' &&
      (candidate.path === root || candidate.path.startsWith(prefix))
    ) {
      events.push({
        type: candidate.type,
        path: toWslUncPath(candidate.path, context.distro)
      })
    }
  }
  return events
}
