// What a bot could share, read from its record, home and automations: the parts a Share dialog offers,
// and the ones that never go out.
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
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
  type BotPackageConnector,
  type BotPackageV1,
  type BotShareLeftOut
} from '../../../shared/bots/bot-package'
import { validateSkillPackageName } from '../../../shared/skills/packages/skill-package-manifest'
import { scanSkillProject } from '../bot-skill-projects'
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
  /** `homePath`: the skill's folder from the bot home, '/'-separated, for opening its files. */
  skills: { name: string; description: string; directory: string; homePath: string }[]
  tools: BotPackageV1['tools']
  schedules: (BotPackageV1['schedules'][number] & { automationId: string })[]
  eventSuggestions: (BotPackageV1['eventSuggestions'][number] & { automationId: string })[]
  memory: { topic: string; path: string }[]
  /** Parts that never go out, and why ("Command · not shared"). */
  leftOut: BotShareLeftOut[]
  connectors: BotPackageConnector[]
}

const validPartName = (name: string): boolean => {
  try {
    validateSkillPackageName(name)
    return true
  } catch {
    return false
  }
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep)
}

/** Every file the export reads goes through here: the bot's own file or folder at this path
 *  (resolved), `linked` when any part of the path is a link (its target could be anything on the
 *  computer, so it never goes out), or null when it is missing. */
async function ownPath(
  home: Home,
  ...segments: string[]
): Promise<{ own: string } | 'linked' | null> {
  const path = join(home.path, ...segments)
  const real = await realpath(path).catch(() => null)
  if (real !== null && real === join(home.real, ...segments)) {
    return { own: real }
  }
  // A dangling link still counts as a link; a missing file under a linked folder has nothing to read.
  return real !== null || (await lstat(path).catch(() => null)) ? 'linked' : null
}

type Home = { path: string; real: string }

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

async function readSkills(
  home: Home,
  leftOut: BotShareable['leftOut']
): Promise<BotShareable['skills']> {
  const scanned = await scanSkillProject(home.path)
  if (!scanned) {
    return []
  }
  const root = await ownPath(home, ...relative(home.path, scanned.skillsDir).split(sep))
  if (root === null || root === 'linked') {
    leftOut.push({ kind: 'skill', name: relative(home.path, scanned.skillsDir), why: 'linked' })
    return []
  }
  const skills: BotShareable['skills'] = []
  for (const skill of scanned.skills) {
    if (!validPartName(skill.name)) {
      leftOut.push({ kind: 'skill', name: skill.name, why: 'name' })
    } else if (!within(root.own, skill.folder)) {
      // A link to a folder outside the home's skills: the owner's, not the bot's.
      leftOut.push({ kind: 'skill', name: skill.name, why: 'outside-home' })
    } else if (!skills.some((entry) => entry.name === skill.name)) {
      skills.push({
        name: skill.name,
        description: skill.description,
        directory: skill.folder,
        homePath: relative(home.real, skill.folder).split(sep).join('/')
      })
    }
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name, 'en-US'))
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
    return { avatar: { mascot: avatar.id }, avatarImage: null }
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

export async function readBotShareable(input: {
  bot: Bot
  home: string
  automations: readonly Automation[]
}): Promise<BotShareable> {
  const leftOut: BotShareable['leftOut'] = []
  const home: Home = { path: input.home, real: await realpath(input.home) }
  const soulPath = await ownPath(home, 'SOUL.md')
  if (soulPath === null || soulPath === 'linked') {
    throw new Error("SOUL.md is missing or is a link; Orca shares only the bot's own files.")
  }
  const soul = await readFile(soulPath.own, 'utf8')
  const automationParts = readAutomations(input.bot, input.automations, leftOut)
  const [skills, servers, memory, avatar] = await Promise.all([
    readSkills(home, leftOut),
    readOwnToolServers(home, leftOut),
    readMemory(home, leftOut),
    readAvatar(input.bot, home, leftOut)
  ])
  return {
    soul,
    purpose: landingLine(soulDescription(soul) ?? '', BOT_PACKAGE_PURPOSE_MAX),
    ...avatar,
    skills,
    tools: readTools(servers, input.home, leftOut),
    ...automationParts,
    memory,
    leftOut,
    connectors: deriveConnectors(input.bot, automationParts)
  }
}
