// Which bots other apps keep on this host, for "Import from another app" and the first-bot nudge. Reads
// folder names and a workspace's IDENTITY.md name line only; config, keys and databases are never opened.
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { Bot } from '../../shared/bot-types'
import {
  botNameFromId,
  type BotImportCandidate,
  type BotImportSource
} from '../../shared/bots/bot-import'

export type BotImportSourcesEnv = {
  home: string
  platform: NodeJS.Platform
  env: Readonly<Record<string, string | undefined>>
}

const MAX_BOTS_PER_APP = 24

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (entry) => entry.isDirectory(),
    () => false
  )
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

async function childFolders(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
}

function tilde(path: string, home: string): string {
  return path === home
    ? '~'
    : path.startsWith(`${home}${sep}`)
      ? `~${path.slice(home.length)}`
      : path
}

/** The name OpenClaw's IDENTITY.md gives the agent ("- **Name:** Molty"), if it has one. */
async function identityName(workspace: string): Promise<string | null> {
  const text = await readFile(join(workspace, 'IDENTITY.md'), 'utf8').catch(() => null)
  const match = text?.match(/^[\s*-]*\**name\**\s*:\s*\**\s*(.+?)\s*$/im)
  const name = match?.[1]?.replace(/\*+$/, '').trim()
  return name && name.length <= 120 && !name.startsWith('(') ? name : null
}

async function openClaw(input: BotImportSourcesEnv): Promise<BotImportSource | null> {
  // Earlier names of the same app; the first that exists is the one in use.
  const roots = [
    input.env.OPENCLAW_STATE_DIR,
    ...['.openclaw', '.clawdbot', '.moltbot'].map((name) => join(input.home, name))
  ].filter((path): path is string => Boolean(path))
  let root: string | null = null
  for (const candidate of roots) {
    if (await isDirectory(candidate)) {
      root = candidate
      break
    }
  }
  if (!root) {
    return null
  }
  const ids = await childFolders(join(root, 'agents'))
  const agents = ids.length ? ids : (await isDirectory(join(root, 'workspace'))) ? ['main'] : []
  const bots: BotImportCandidate[] = []
  for (const agent of agents.slice(0, MAX_BOTS_PER_APP)) {
    const places = [
      ...(agent === 'main' ? [join(root, 'workspace')] : []),
      join(root, `workspace-${agent}`),
      join(root, 'workspace', agent)
    ]
    let workspace: string | null = null
    for (const place of places) {
      if (await isDirectory(place)) {
        workspace = place
        break
      }
    }
    // An agent without a workspace Orca can see is still listed; its bot finds the folder.
    const folder = workspace ?? join(root, 'agents', agent)
    bots.push({
      agent,
      name: (workspace && (await identityName(workspace))) ?? botNameFromId(agent),
      path: tilde(folder, input.home),
      absolutePath: folder
    })
  }
  return { app: 'openclaw', home: tilde(root, input.home), bots }
}

async function isHermesProfile(folder: string): Promise<boolean> {
  return (await exists(join(folder, 'SOUL.md'))) || (await exists(join(folder, 'config.yaml')))
}

async function hermes(input: BotImportSourcesEnv): Promise<BotImportSource | null> {
  // A HERMES_HOME that names a profile points two levels below the Hermes folder.
  const set = input.env.HERMES_HOME?.replace(/[\\/]profiles[\\/][^\\/]+[\\/]?$/, '')
  const root = set || join(input.home, '.hermes')
  if (!(await isDirectory(root))) {
    return null
  }
  const bots: BotImportCandidate[] = []
  if (await isHermesProfile(root)) {
    bots.push({
      agent: 'default',
      name: 'Hermes',
      path: tilde(root, input.home),
      absolutePath: root
    })
  }
  for (const profile of await childFolders(join(root, 'profiles'))) {
    const folder = join(root, 'profiles', profile)
    if (bots.length < MAX_BOTS_PER_APP && (await isHermesProfile(folder))) {
      bots.push({
        agent: profile,
        name: botNameFromId(profile),
        path: tilde(folder, input.home),
        absolutePath: folder
      })
    }
  }
  return { app: 'hermes', home: tilde(root, input.home), bots }
}

function openBotDataFolder(input: BotImportSourcesEnv): string {
  return input.platform === 'darwin'
    ? join(input.home, 'Library', 'Application Support', 'OpenBot')
    : input.platform === 'win32'
      ? join(input.env.APPDATA ?? join(input.home, 'AppData', 'Roaming'), 'OpenBot')
      : join(input.env.XDG_CONFIG_HOME ?? join(input.home, '.config'), 'OpenBot')
}

async function openBot(input: BotImportSourcesEnv): Promise<BotImportSource | null> {
  const data = openBotDataFolder(input)
  const agentsRoot = join(input.home, 'OpenBot', 'Agents')
  if (!(await isDirectory(data)) && !(await isDirectory(agentsRoot))) {
    return null
  }
  const bots = (await childFolders(agentsRoot)).slice(0, MAX_BOTS_PER_APP).map((agent) => {
    const id = agent.replace(/^(agent|bot)-/, '')
    // Older agents are named by a random id; their bot reads the real name from OpenBot.
    const named = !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)
    const folder = join(agentsRoot, agent)
    return {
      agent,
      name: named ? botNameFromId(id) : 'OpenBot agent',
      path: tilde(folder, input.home),
      absolutePath: folder
    }
  })
  return { app: 'openbot', home: tilde(data, input.home), bots }
}

/** The apps found, each with its bots, and the Orca bot an earlier import made from each. */
export async function findBotImportSources(
  input: BotImportSourcesEnv,
  bots: readonly Pick<Bot, 'id' | 'name' | 'importedFrom'>[]
): Promise<BotImportSource[]> {
  const found = await Promise.all([openClaw(input), hermes(input), openBot(input)])
  return found
    .filter((source): source is BotImportSource => source !== null)
    .map((source) => ({
      ...source,
      bots: source.bots.map((candidate) => {
        const earlier = bots.find(
          (bot) =>
            bot.importedFrom?.app === source.app && bot.importedFrom.path === candidate.absolutePath
        )
        return earlier
          ? { ...candidate, importedAs: { botId: earlier.id, name: earlier.name } }
          : candidate
      })
    }))
}
