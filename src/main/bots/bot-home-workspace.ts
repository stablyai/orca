import type { Bot } from '../../shared/bot-types'
import type { RuntimeStore } from '../runtime/construction/runtime-store-contract'
import type { BotControllerDependencies } from './bot-controller'
import { botHomeFolder, isBotsProjectGroup } from './bot-home'

export type HomeStore = Required<Pick<RuntimeStore, 'getProjectGroups' | 'createProjectGroup'>>
type HomeRecord = { folder: string; folderWorkspaceId: string }

/** How every home in the hidden Bots group is made, a bot's own or one shared with this account: its
 *  surface is its agent's chat, which whoever opens it shows, so making it starts no terminal there. */
export type BotsHomeCreateInput = {
  projectGroupId: string
  name: string
  folderPath: string
  agentLaunchMode: 'structured'
  /** Absent for a shared agent's home: its owner's computer runs it, on an agent not known here. */
  createdWithAgent?: Bot['agent']
}

export function botsHomeCreateInput(
  store: HomeStore,
  botsRoot: string,
  home: { name: string; folderPath: string; agent?: Bot['agent'] }
): BotsHomeCreateInput {
  return {
    projectGroupId: botsProjectGroupId(store, botsRoot),
    name: home.name,
    folderPath: home.folderPath,
    agentLaunchMode: 'structured',
    ...(home.agent ? { createdWithAgent: home.agent } : {})
  }
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
    const workspace = await deps.createFolderWorkspace(
      botsHomeCreateInput(store, botsRoot, { name, folderPath: path, agent })
    )
    return { folder, folderWorkspaceId: workspace.id }
  } catch (error) {
    await deps.filesystem.removeTree(path)
    throw error
  }
}

/** The hidden Bots group every bot home lives in, made the first time one is. */
export function botsProjectGroupId(store: HomeStore, botsRoot: string): string {
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
