// A bot's home folder: what it is (SOUL.md), what it remembers (MEMORY.md, memory/) and the files that point its agent at both.
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import type { Bot } from '../../shared/bot-types'
import { starterSoul } from '../../shared/bot-soul'
import { normalizeRuntimePathForComparison } from '../../shared/file-access/cross-platform-path'
import { errnoCodeOrUnknown } from '../../shared/errors/errno-code'
import type { ProjectGroup } from '../../shared/project/groups/project-group-types'
import { getDiskBaselineSignature } from '../../shared/file-write/disk-baseline-signature'
import { writeLocalTextFileWithDiskPrecondition } from '../filesystem/local-file-io/local-disk-write-precondition'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'

/** The disk a bot home lives on; only this computer's today, an SSH/WSL adapter later. */
export type BotHomeFilesystem = {
  /** Null when the file is missing or unreadable. */
  readText(path: string): Promise<string | null>
  /** Null when the file is missing or unreadable. */
  readBytes(path: string): Promise<Buffer | null>
  /** A folder's entry names; none when it is missing or unreadable. */
  listNames(path: string): Promise<string[]>
  /** A file's size and last change; null when it is missing or unreadable. */
  statFile(path: string): Promise<{ size: number; mtimeMs: number } | null>
  writeBytes(path: string, bytes: Uint8Array): Promise<void>
  /** `exclusive` leaves an existing file untouched and reports false. */
  writeText(path: string, text: string, options?: { exclusive?: boolean }): Promise<boolean>
  /** Writes `text` only if the file still holds `expected`; false when it changed meanwhile. */
  replaceText(path: string, expected: string, text: string): Promise<boolean>
  /** Creates missing parents; false when `path` itself already existed, so two creators never share it. */
  reserveDirectory(path: string): Promise<boolean>
  makeDirectory(path: string): Promise<void>
  removeTree(path: string): Promise<void>
}

export const localBotHomeFilesystem: BotHomeFilesystem = {
  readText: (path) => readFile(path, 'utf8').catch(() => null),
  readBytes: (path) => readFile(path).catch(() => null),
  listNames: (path) => readdir(path).catch(() => []),
  statFile: (path) =>
    stat(path).then(
      ({ size, mtimeMs }) => ({ size, mtimeMs }),
      () => null
    ),
  writeBytes: (path, bytes) => writeFile(path, bytes),
  writeText: async (path, text, options) => {
    try {
      await writeFile(path, text, options?.exclusive ? { flag: 'wx' } : undefined)
      return true
    } catch (error) {
      if (options?.exclusive && errnoCodeOrUnknown(error) === 'EEXIST') {
        return false
      }
      throw error
    }
  },
  replaceText: async (path, expected, text) =>
    (
      await writeLocalTextFileWithDiskPrecondition(path, text, {
        expectedSignature: getDiskBaselineSignature(expected)
      })
    ).ok,
  reserveDirectory: async (path) => {
    await mkdir(dirname(path), { recursive: true })
    try {
      await mkdir(path)
      return true
    } catch (error) {
      if (errnoCodeOrUnknown(error) === 'EEXIST') {
        return false
      }
      throw error
    }
  },
  makeDirectory: async (path) => {
    await mkdir(path, { recursive: true })
  },
  removeTree: (path) => rm(path, { recursive: true, force: true })
}

export type BotsRootPaths = {
  userData: string
  appData: string
  home: string
  xdgDataHome?: string
}

// A shared-home SSH server's per-machine data root, `~/.orca-<machine key prefix>`.
const MACHINE_DATA_ROOT = /^\.orca-[a-f0-9]{8}$/u

/** The hidden Bots project group's folder: `~/.orca/bots` for every profile a real setup runs on
 *  (desktop, shared dev, orcad's defaults, shared-home servers), `<userData>/bots` for any other
 *  data folder, so isolated runs never write into the real setup. */
export function botsRootFolder(paths: BotsRootPaths = currentBotsRootPaths()): string {
  // Case-folded: app.setName can recase a default profile's path on case-insensitive disks.
  const comparable = (path: string) => normalizeRuntimePathForComparison(path).toLowerCase()
  const userData = comparable(paths.userData)
  const standardProfiles = [
    join(paths.appData, 'orca'),
    join(paths.appData, 'orca-dev'),
    join(paths.home, '.orca'),
    ...(paths.xdgDataHome ? [join(paths.xdgDataHome, 'Orca')] : [])
  ].map(comparable)
  const machineDataRoot =
    comparable(dirname(paths.userData)) === comparable(paths.home) &&
    MACHINE_DATA_ROOT.test(basename(userData))
  return standardProfiles.includes(userData) || machineDataRoot
    ? join(paths.home, '.orca', 'bots')
    : join(paths.userData, 'bots')
}

function currentBotsRootPaths(): BotsRootPaths {
  return {
    userData: getCanonicalUserDataPath(),
    appData: getAppEnvironment().getPath('appData'),
    home: homedir(),
    xdgDataHome: process.env.XDG_DATA_HOME || undefined
  }
}

/** Bots are listed as bots, never as a project. */
export function isBotsProjectGroup(
  group: Pick<ProjectGroup, 'parentPath' | 'connectionId'>,
  botsRoot: string = botsRootFolder()
): boolean {
  return (
    !group.connectionId &&
    typeof group.parentPath === 'string' &&
    normalizeRuntimePathForComparison(group.parentPath) ===
      normalizeRuntimePathForComparison(botsRoot)
  )
}

/** `<bots root>/<bot.folder>`. */
export function botHomeFolder(
  bot: Pick<Bot, 'folder'>,
  botsRoot: string = botsRootFolder()
): string {
  return join(botsRoot, bot.folder)
}

type BotHomeFile = { path: string; text: string }

/** Orca owns these and rewrites them whenever they differ. */
export function generatedBotHomeFiles(bot: Bot): BotHomeFile[] {
  return [
    {
      path: 'AGENTS.md',
      text: [
        `# ${bot.name}`,
        '',
        `You are ${bot.name}, a bot that runs in Orca. This folder is your home.`,
        '',
        '- SOUL.md says who you are and how you work. Change it only when your owner asks.',
        '- MEMORY.md is your memory: one line per fact, details in memory/<topic>.md.',
        '- Keep it current: date new lines, never store secrets. Remove or replace a line with `orca bot memory forget --fact "<its words>"`; a line taken out any other way is put back.',
        '',
        'Orca writes this file, CLAUDE.md and bot.json; edits to them are replaced.',
        ''
      ].join('\n')
    },
    { path: 'CLAUDE.md', text: '@AGENTS.md\n' },
    {
      path: 'bot.json',
      text: `${JSON.stringify(
        {
          id: bot.id,
          name: bot.name,
          agent: bot.agent,
          avatar: bot.avatar,
          members: bot.members,
          ...(bot.skillProjects?.length ? { skillProjects: bot.skillProjects } : {})
        },
        null,
        2
      )}\n`
    }
  ]
}

/** The user's own; written only when missing, so a re-created bot keeps its soul and memory. A bot
 *  made from a template or proposal starts with that soul instead of the starter. */
export function seededBotHomeFiles(bot: Bot, soul?: string): BotHomeFile[] {
  return [
    {
      path: 'SOUL.md',
      text: soul ?? starterSoul(bot.name)
    },
    { path: 'MEMORY.md', text: BOT_MEMORY_SEED }
  ]
}

export const BOT_MEMORY_SEED =
  '# Memory\n\nOne line per fact, newest first. Longer notes go in memory/<topic>.md.\n'

/** Safe to repeat: seeded files are never overwritten and generated ones are written only on change. */
export async function writeBotHome(
  fs: BotHomeFilesystem,
  folder: string,
  bot: Bot,
  soul?: string
): Promise<void> {
  await assertBotOwnsHome(fs, folder, bot.id)
  await fs.makeDirectory(join(folder, 'memory'))
  for (const file of seededBotHomeFiles(bot, soul)) {
    await fs.writeText(join(folder, file.path), file.text, { exclusive: true })
  }
  for (const file of generatedBotHomeFiles(bot)) {
    const path = join(folder, file.path)
    if ((await fs.readText(path)) !== file.text) {
      await fs.writeText(path, file.text)
    }
  }
}

/** Refuses a home whose bot.json names another bot; a missing one (new or partly removed home) is this bot's. */
export async function assertBotOwnsHome(
  fs: BotHomeFilesystem,
  folder: string,
  botId: string
): Promise<void> {
  const text = await fs.readText(join(folder, 'bot.json'))
  let id: unknown
  try {
    const record: unknown = text === null ? null : JSON.parse(text)
    id = typeof record === 'object' && record !== null && 'id' in record ? record.id : undefined
  } catch {
    id = undefined
  }
  if (typeof id === 'string' && id !== botId) {
    throw new Error('bot_folder_not_owned')
  }
}
