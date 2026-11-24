import type { PRWatchServiceDeps } from './pr-watch-types'

export async function sweepGonePRChats(
  deps: PRWatchServiceDeps,
  stopped: () => boolean,
  watches: Iterable<string>,
  forget: (id: string) => void,
  end: (key: string) => Promise<void>
): Promise<void> {
  const chatIds = await deps.database.read({ kind: 'watch-chats' })
  if (stopped()) {
    return
  }
  const gone = chatIds.filter((id) => !deps.chatExists(id))
  const owned = new Set(await deps.database.write({ kind: 'delete-chats', chatIds: gone }))
  if (stopped()) {
    return
  }
  gone.forEach(forget)
  for (const key of watches) {
    if (!owned.has(key)) {
      await end(key)
    }
  }
}
