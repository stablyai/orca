import type { Bot } from '../../shared/bot-types'
import type { RuntimeStore } from '../runtime/construction/runtime-store-contract'

export type BotStore = Required<
  Pick<
    RuntimeStore,
    | 'getBots'
    | 'saveBot'
    | 'removeBot'
    | 'getProjectGroups'
    | 'createProjectGroup'
    | 'getFolderWorkspaces'
    | 'updateFolderWorkspace'
  >
> &
  Pick<RuntimeStore, 'flushPendingOrThrowAsync'>

// Its home folder is already made or gone on disk, so the record must not wait out the save debounce: a
// quit or crash inside it would bring back a deleted bot, or lose a new one's record beside its folder.
export async function persistBotStore(store: BotStore): Promise<void> {
  await store.flushPendingOrThrowAsync?.({ drainToStableGeneration: false })
}

function isBotStore(store: RuntimeStore | null): store is RuntimeStore & BotStore {
  return Boolean(
    store?.getBots &&
    store.saveBot &&
    store.removeBot &&
    store.getProjectGroups &&
    store.createProjectGroup &&
    store.getFolderWorkspaces &&
    store.updateFolderWorkspace
  )
}

export function requireBotStore(store: RuntimeStore | null): BotStore {
  if (!isBotStore(store)) {
    throw new Error('runtime_unavailable')
  }
  return store
}

export function requireStoredBot(store: BotStore, botId: string): Bot {
  const bot = store.getBots().find((entry) => entry.id === botId)
  if (!bot) {
    throw new Error('bot_not_found')
  }
  return bot
}
