// A new bot's record before its home exists: its id, defaults, and what an import made it from.
import { randomUUID } from 'node:crypto'
import { randomMascotAvatar } from '../../shared/bot-avatar'
import type { Bot } from '../../shared/bot-types'
import type { BotImportedFrom } from '../../shared/bots/bot-import'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host/execution-host'
import type { BotCreateParams } from '../../shared/rpc-contract/bots-params'

/** What a new bot keeps of the import it was made by; the reply itself goes in its home. */
function importedFrom({
  reply,
  ...from
}: NonNullable<BotCreateParams['importFrom']>): BotImportedFrom {
  return { ...from, ...(reply?.trim() ? { reply: true } : {}) }
}

export function newBotRecord(
  input: BotCreateParams,
  now: number
): Omit<Bot, 'folder' | 'folderWorkspaceId'> {
  return {
    id: randomUUID(),
    name: input.name,
    hostId: LOCAL_EXECUTION_HOST_ID,
    agent: input.agent ?? 'claude',
    ...(input.launch ? { launch: input.launch } : {}),
    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    avatar: input.avatar === undefined ? randomMascotAvatar(null) : input.avatar,
    ...(input.avatarColor ? { avatarColor: input.avatarColor } : {}),
    paused: false,
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    chatSessionId: null,
    firstRun: true,
    ...(input.importFrom ? { importedFrom: importedFrom(input.importFrom) } : {}),
    ...(input.fromOffer && !input.fromOffer.botId ? { fromOfferId: input.fromOffer.offerId } : {}),
    linear: null,
    github: null,
    createdAt: now,
    updatedAt: now
  }
}
