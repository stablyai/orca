// What a bot could share, read from its record, home and automations: the parts a Share dialog offers,
// and the ones that never go out.
import { readdir, readFile, realpath } from 'node:fs/promises'
import { basename, relative, sep } from 'node:path'
import { isConnectorTrigger } from '../../../shared/automation-event-triggers'
import { isGoogleTrigger } from '../../../shared/automation-google-triggers'
import type { Automation } from '../../../shared/automations/automation-definition'
import {
  BOT_AVATAR_FILE,
  isBotAvatarImage,
  isUploadAvatar,
  parseBotAvatar
} from '../../../shared/bot-avatar'
import { soulDescription } from '../../../shared/bot-soul'
import type { BotToolServer } from '../../../shared/bot-tools'
import { botLinearWorkspaces, botSlackApps, type Bot } from '../../../shared/bot-types'
import {
  BOT_PACKAGE_PURPOSE_MAX,
  botPackageResults,
  packagedMascotLook,
  type BotPackageConnector,
  type BotPackageV1,
  type BotShareLeftOut
} from '../../../shared/bots/bot-package'
import type { Repo } from '../../../shared/repository/repo-types'
import { botHomeFolder } from '../bot-home'
import { localSkillProjects } from '../bot-skill-projects'
import { ownPath, validPartName, type Home } from './bot-share-own-path'
import { readShareSkills, type BotShareSkill } from './bot-share-skills'
import {
  skillsSessionKey,
  type BotShareSkillListing,
  type BotShareSkillsRead
} from './bot-share-skill-reads'
import { botToolCredentialHeaderNames } from '../bot-tool-credentials'
import { botToolsPath, readBotToolServers } from '../bot-tools-file'
import { landingLine } from './bot-package-transport'
import { stripPngMetadata } from './png-metadata-strip'

/** Everything the bot could share, before the owner picks. */
export type BotShareable = {
  soul: string
  purpose: string
  avatar: BotPackageV1['avatar']
  avatarImage: Buffer | null
  skills: BotShareSkill[]
  tools: BotPackageV1['tools']
  schedules: (BotPackageV1['schedules'][number] & { automationId: string })[]
  eventSuggestions: (BotPackageV1['eventSuggestions'][number] & { automationId: string })[]
  memory: { topic: string; path: string }[]
  /** Parts that never go out, and why ("Command · not shared"). */
  leftOut: BotShareLeftOut[]
  connectors: BotPackageConnector[]
}

/** `.orca/bot-tools.json`, as the tools file module names it. */
const BOT_TOOLS_FILE_SEGMENTS = relative('home', botToolsPath('home')).split(sep)

/** An HTTP tool's address without its sign-in part, query or fragment; the path stays. */
function shareableToolUrl(url: string): string {
  const parsed = new URL(url)
  parsed.username = ''
  parsed.password = ''
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

function readTools(
  servers: readonly BotToolServer[],
  home: string,
  leftOut: BotShareable['leftOut']
): BotShareable['tools'] {
  return servers.flatMap((server, index) => {
    if (!('url' in server)) {
      leftOut.push({ kind: 'tool', name: server.name, why: 'command' })
      return []
    }
    const headerNames = server.credential
      ? botToolCredentialHeaderNames(home, server.credential)
      : Object.keys(server.headers ?? {})
    return [
      {
        id: `t${index + 1}`,
        name: server.name,
        url: shareableToolUrl(server.url),
        headerNames: [...new Set(headerNames)].sort()
      }
    ]
  })
}

function readAutomations(
  bot: Bot,
  automations: readonly Automation[],
  leftOut: BotShareable['leftOut']
): Pick<BotShareable, 'schedules' | 'eventSuggestions'> {
  const own = automations.filter(
    (automation) => automation.bot?.botId === bot.id && !automation.once
  )
  const schedules: BotShareable['schedules'] = []
  const eventSuggestions: BotShareable['eventSuggestions'] = []
  for (const automation of own) {
    const results = botPackageResults(automation.bot?.resultsTo ?? 'chat')
    if (!automation.on?.length) {
      schedules.push({
        automationId: automation.id,
        id: `s${schedules.length + 1}`,
        name: automation.name,
        prompt: automation.prompt,
        rrule: automation.rrule,
        ...(automation.timezoneExplicit ? { timezone: automation.timezone } : {}),
        results: results === 'thread' ? 'chat' : results
      })
      continue
    }
    for (const trigger of automation.on) {
      if (!isConnectorTrigger(trigger) && !isGoogleTrigger(trigger)) {
        leftOut.push({ kind: 'automation', name: automation.name, why: 'webhook' })
        continue
      }
      const textContains = 'textContains' in trigger ? trigger.textContains : undefined
      eventSuggestions.push({
        automationId: automation.id,
        id: `e${eventSuggestions.length + 1}`,
        name: automation.name,
        prompt: automation.prompt,
        source: trigger.source,
        event: trigger.event,
        ...(textContains ? { textContains } : {}),
        results
      })
    }
  }
  return { schedules, eventSuggestions }
}

async function readMemory(
  home: Home,
  leftOut: BotShareable['leftOut']
): Promise<BotShareable['memory']> {
  const folder = await ownPath(home, 'memory')
  if (folder === 'linked') {
    leftOut.push({ kind: 'memory', name: 'memory', why: 'linked' })
  }
  if (folder === null || folder === 'linked') {
    return []
  }
  const entries = await readdir(folder.own, { withFileTypes: true })
  const notes = await Promise.all(
    entries
      .filter((entry) => entry.name.endsWith('.md') && (entry.isFile() || entry.isSymbolicLink()))
      .map(async (entry) => ({
        topic: entry.name.slice(0, -'.md'.length),
        path: await ownPath(home, 'memory', entry.name)
      }))
  )
  return notes
    .flatMap(({ topic, path }) => {
      // Notes an import brought in are the old app's, never the sharer's to pass on.
      const why =
        path === 'linked'
          ? 'linked'
          : topic.startsWith('imported-')
            ? 'imported'
            : validPartName(topic)
              ? null
              : 'name'
      if (why || path === null || path === 'linked') {
        leftOut.push({ kind: 'memory', name: topic, why: why ?? 'missing' })
        return []
      }
      return [{ topic, path: path.own }]
    })
    .sort((left, right) => left.topic.localeCompare(right.topic, 'en-US'))
}

/** The bot's tools file, read only when neither it nor `.orca` is a link. */
async function readOwnToolServers(
  home: Home,
  leftOut: BotShareable['leftOut']
): Promise<BotToolServer[]> {
  const file = await ownPath(home, ...BOT_TOOLS_FILE_SEGMENTS)
  if (file === 'linked') {
    leftOut.push({ kind: 'tool', name: BOT_TOOLS_FILE_SEGMENTS.join('/'), why: 'linked' })
  }
  return file === null || file === 'linked' ? [] : readBotToolServers(home.path)
}

async function readAvatar(
  bot: Bot,
  home: Home,
  leftOut: BotShareable['leftOut']
): Promise<Pick<BotShareable, 'avatar' | 'avatarImage'>> {
  const avatar = parseBotAvatar(bot.avatar)
  if (avatar?.kind === 'mascot') {
    return { avatar: { mascot: avatar.id, ...packagedMascotLook(bot) }, avatarImage: null }
  }
  if (avatar?.kind === 'upload' && isUploadAvatar(bot.avatar)) {
    const path = await ownPath(home, BOT_AVATAR_FILE)
    const png = path && path !== 'linked' ? await readFile(path.own).catch(() => null) : null
    const stripped = png && isBotAvatarImage(png) ? stripPngMetadata(png) : null
    if (stripped) {
      return { avatar: { image: BOT_AVATAR_FILE }, avatarImage: stripped }
    }
    leftOut.push({
      kind: 'avatar',
      name: BOT_AVATAR_FILE,
      why: path === 'linked' ? 'linked' : 'invalid'
    })
  }
  return { avatar: undefined, avatarImage: null }
}

/** The accounts a copy needs: what the bot is connected to, and what its automations post to or
 *  listen on. Never picked by the sharer. */
export function deriveConnectors(
  bot: Bot,
  parts: Pick<BotShareable, 'schedules' | 'eventSuggestions'>
): BotPackageConnector[] {
  const kinds = new Set<BotPackageConnector>()
  const connected: [boolean, BotPackageConnector][] = [
    [botSlackApps(bot).length > 0, 'slack'],
    [botLinearWorkspaces(bot).length > 0, 'linear'],
    [bot.github !== null, 'github'],
    [bot.google === true, 'google']
  ]
  for (const [on, kind] of connected) {
    if (on) {
      kinds.add(kind)
    }
  }
  for (const { results } of [...parts.schedules, ...parts.eventSuggestions]) {
    if (results === 'slack-channel' || results === 'linear-issue') {
      kinds.add(results === 'slack-channel' ? 'slack' : 'linear')
    }
  }
  for (const { source } of parts.eventSuggestions) {
    kinds.add(source === 'gmail' || source === 'calendar' ? 'google' : source)
  }
  return [...kinds].sort()
}

export async function readBotShareable(
  input: {
    bot: Bot
    /** The bot's home folder; its own by default. */
    home?: string
    automations: readonly Automation[]
    /** The app's projects: the bot's linked ones on this host are skills its chats load too. */
    repos?: readonly Repo[]
  } & BotShareSkillsRead
): Promise<BotShareable> {
  const leftOut: BotShareable['leftOut'] = []
  const homePath = input.home ?? botHomeFolder(input.bot)
  const home: Home = { path: homePath, real: await realpath(homePath) }
  const skillProjects = localSkillProjects(input.bot.skillProjects ?? [], input.repos ?? []).map(
    (repo) => ({
      name: repo.displayName.trim() || basename(repo.path).trim() || repo.id,
      path: repo.path
    })
  )
  const soulPath = await ownPath(home, 'SOUL.md')
  if (soulPath === null || soulPath === 'linked') {
    throw new Error("SOUL.md is missing or is a link; Orca shares only the bot's own files.")
  }
  const soul = await readFile(soulPath.own, 'utf8')
  const automationParts = readAutomations(input.bot, input.automations, leftOut)
  const listSkills = async (signal?: AbortSignal): Promise<BotShareSkillListing> => {
    const skillsLeftOut: BotShareLeftOut[] = []
    const skills = await readShareSkills(input.bot, home, skillsLeftOut, skillProjects, signal)
    return { skills, leftOut: skillsLeftOut }
  }
  // A project path that now resolves elsewhere lists that folder's skills, so it reads again.
  const projectRoots = await Promise.all(
    skillProjects.map((project) => realpath(project.path).catch(() => null))
  )
  const sources = JSON.stringify([
    input.bot.agent,
    home.path,
    home.real,
    skillProjects,
    projectRoots
  ])
  const readSkills = async (): Promise<BotShareSkill[]> => {
    const listing = await (input.skillReads && input.session
      ? input.skillReads.read(
          skillsSessionKey(input.bot.id, input.session),
          sources,
          input.reuseSkills === true,
          listSkills,
          input.build
        )
      : listSkills())
    for (const entry of listing.leftOut) {
      leftOut.push(entry)
    }
    return [...listing.skills]
  }
  const [skills, servers, memory, avatar] = await Promise.all([
    readSkills(),
    readOwnToolServers(home, leftOut),
    readMemory(home, leftOut),
    readAvatar(input.bot, home, leftOut)
  ])
  return {
    soul,
    purpose: landingLine(soulDescription(soul) ?? '', BOT_PACKAGE_PURPOSE_MAX),
    ...avatar,
    skills,
    tools: readTools(servers, homePath, leftOut),
    ...automationParts,
    memory,
    leftOut,
    connectors: deriveConnectors(input.bot, automationParts)
  }
}
