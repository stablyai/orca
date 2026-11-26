import { join } from 'node:path'
import type { Bot } from '../../shared/bot-types'
import { BOT_IMPORT_REPLY_FILE } from '../../shared/bots/bot-import'
import { proposalSoul } from '../../shared/bots/bot-proposal'
import { botTemplate } from '../../shared/bots/bot-templates'
import { templateBotFolderName } from '../../shared/bots/bot-template-view'
import type { BotCreateParams } from '../../shared/rpc-contract/bots-params'
import type { RuntimeStore } from '../runtime/construction/runtime-store-contract'
import { type commanderBotDefaults, commanderSoul } from './commander-bot'
import { freeBotName } from './bot-free-name'
import { newBotRecord } from './bot-new-record'
import type { BotControllerDependencies, BotOrigin } from './bot-controller'
import { botHomeFolder, isBotsProjectGroup, writeBotHome } from './bot-home'

type HomeStore = Required<Pick<RuntimeStore, 'getProjectGroups' | 'createProjectGroup'>>
type HomeRecord = { folder: string; folderWorkspaceId: string }

/** The new bot with its home written, not yet saved; run inside the queue. */
export async function createBotWithHome(
  deps: Pick<BotControllerDependencies, 'botsRoot' | 'filesystem' | 'createFolderWorkspace'>,
  store: HomeStore & Required<Pick<RuntimeStore, 'getBots'>>,
  input: BotCreateParams,
  origin: BotOrigin | typeof commanderBotDefaults = {}
): Promise<Bot> {
  const name = freeBotName(store.getBots(), input.name)
  const draft = { ...newBotRecord({ ...input, name }, Date.now()), ...origin }
  const bot: Bot = {
    ...draft,
    ...(await makeBotsHome(
      deps,
      store,
      templateBotFolderName(name, botTemplate(draft.templateId), input.templateNameShown),
      name,
      draft.agent,
      (path, folder) =>
        writeBotHome(
          deps.filesystem,
          path,
          { ...draft, folder, folderWorkspaceId: '' },
          draft.systemRole === 'commander'
            ? commanderSoul
            : input.seed
              ? proposalSoul(name, input.seed)
              : undefined
        )
    ))
  }
  const reply = input.importFrom?.reply?.trim()
  if (reply) {
    // The old bot's own words: read as data by the import, never sent as a turn.
    const home = botHomeFolder(bot, deps.botsRoot())
    await deps.filesystem.makeDirectory(join(home, 'import'))
    await deps.filesystem.writeText(join(home, BOT_IMPORT_REPLY_FILE), `${reply}\n`)
  }
  return bot
}

/** Reserves `<bots root>/<slug>` (else `<slug>-2`...) and makes its folder workspace in the
 *  hidden Bots group: a bot's home, or a group's. `fill` writes into the folder first; a failure
 *  removes the freshly reserved folder, which holds nothing of the user's yet. */
export async function makeBotsHome(
  deps: Pick<BotControllerDependencies, 'botsRoot' | 'filesystem' | 'createFolderWorkspace'>,
  store: HomeStore,
  slug: string,
  name: string,
  agent: Bot['agent'],
  fill: (path: string, folder: string) => Promise<void> = async () => {}
): Promise<HomeRecord> {
  const botsRoot = deps.botsRoot()
  const folder = await reserveFolder(deps, botsRoot, slug)
  const path = botHomeFolder({ folder }, botsRoot)
  try {
    await fill(path, folder)
    const workspace = await deps.createFolderWorkspace({
      projectGroupId: botsGroupId(store, botsRoot),
      name,
      folderPath: path,
      createdWithAgent: agent
    })
    return { folder, folderWorkspaceId: workspace.id }
  } catch (error) {
    await deps.filesystem.removeTree(path)
    throw error
  }
}

function botsGroupId(store: HomeStore, botsRoot: string): string {
  const existing = store.getProjectGroups().find((group) => isBotsProjectGroup(group, botsRoot))
  return (
    existing ??
    store.createProjectGroup({
      name: 'Bots',
      parentPath: botsRoot,
      createdFrom: 'manual'
    })
  ).id
}

/** A folder already on disk may be a kept or another profile's bot, so it is never reused. */
async function reserveFolder(
  deps: Pick<BotControllerDependencies, 'filesystem'>,
  botsRoot: string,
  slug: string
): Promise<string> {
  for (let suffix = 1; ; suffix++) {
    const folder = suffix === 1 ? slug : `${slug}-${suffix}`
    if (await deps.filesystem.reserveDirectory(botHomeFolder({ folder }, botsRoot))) {
      return folder
    }
  }
}
