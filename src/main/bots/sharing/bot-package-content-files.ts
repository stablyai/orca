// The raw files a package value is built from (a bot's home, or a verified archive), and the folder an
// archive is packed from. Path, size, depth and link checks stay here, with the readers that own them.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  BOT_PACKAGE_AVATAR_PATH,
  BOT_PACKAGE_MANIFEST_PATH,
  BOT_PACKAGE_SOUL_PATH,
  type BotPackageV1,
  type BotShareLeftOut
} from '../../../shared/bots/bot-package'
import type { BotPackageContent, BotPackageRawFile } from './bot-package-content'
import type { BotTransportManifest } from './bot-package-transport'
import type { BotShareable } from './bot-share-sources'
import { ownSkillFiles, unpackableWhy } from './bot-share-skills'

/** The picked parts of a bot's home, as they are now. A skill folder is read through the skill
 *  package observer, which refuses links and holds the size and depth limits; a skill nested inside
 *  it is its own part and stays out. A picked skill or note whose files can't be read is refused
 *  whole, with why, so it never stops the rest from going out. */
export async function sharerRawFiles(
  shareable: BotShareable,
  bot: BotPackageV1
): Promise<{ files: BotPackageRawFile[]; refused: BotShareLeftOut[] }> {
  const files: BotPackageRawFile[] = [
    { path: BOT_PACKAGE_SOUL_PATH, bytes: Buffer.from(shareable.soul, 'utf8') }
  ]
  if (shareable.avatarImage && bot.avatar && 'image' in bot.avatar) {
    files.push({ path: BOT_PACKAGE_AVATAR_PATH, bytes: shareable.avatarImage })
  }
  const refused: BotShareLeftOut[] = []
  for (const { name } of bot.skills) {
    const skill = shareable.skills.find((entry) => entry.name === name)
    if (!skill) {
      continue
    }
    try {
      files.push(...(await skillRawFiles(name, skill.directory)))
    } catch (error) {
      refused.push({ kind: 'skill', name, why: unpackableWhy(error) })
    }
  }
  for (const { topic } of bot.memory) {
    const note = shareable.memory.find((entry) => entry.topic === topic)
    if (!note) {
      continue
    }
    try {
      files.push({ path: `memory/${topic}.md`, bytes: await readFile(note.path) })
    } catch {
      refused.push({ kind: 'memory', name: topic, why: 'unreadable' })
    }
  }
  return { files, refused }
}

/** All of one skill's files, or a throw: none are kept until every one has been read. */
async function skillRawFiles(name: string, directory: string): Promise<BotPackageRawFile[]> {
  const files: BotPackageRawFile[] = []
  for (const file of await ownSkillFiles(directory)) {
    files.push({
      path: `skills/${name}/${file.path}`,
      bytes: await readFile(join(directory, ...file.path.split('/')))
    })
  }
  return files
}

/** The shareable without the picked parts packing refused, which join its left-out parts. */
export function withoutRefusedParts(
  shareable: BotShareable,
  refused: readonly BotShareLeftOut[]
): BotShareable {
  if (refused.length === 0) {
    return shareable
  }
  const refusedNames = (kind: BotShareLeftOut['kind']) =>
    new Set(refused.filter((entry) => entry.kind === kind).map((entry) => entry.name))
  const skills = refusedNames('skill')
  const notes = refusedNames('memory')
  return {
    ...shareable,
    skills: shareable.skills.filter((skill) => !skills.has(skill.name)),
    memory: shareable.memory.filter((note) => !notes.has(note.topic)),
    leftOut: [...shareable.leftOut, ...refused]
  }
}

/** Files whose shared text isn't the home's (a SKILL.md rebuilt from its frontmatter): their line
 *  numbers aren't the home file's, so the dialog doesn't offer to open the home file at a line. */
export function rewrittenPaths(
  content: BotPackageContent,
  raw: readonly BotPackageRawFile[]
): string[] {
  return content.files
    .filter((file) => {
      const source = raw.find((entry) => entry.path === file.path)
      return !source || Buffer.from(source.bytes).toString('utf8') !== file.text
    })
    .map((file) => file.path)
}

/** The files of an archive the reader verified and unpacked into `directory`. */
export async function archiveRawFiles(
  directory: string,
  transport: BotTransportManifest
): Promise<BotPackageRawFile[]> {
  return Promise.all(
    transport.files
      .filter((file) => file.role !== 'manifest')
      .map(async (file) => ({
        path: file.path,
        bytes: await readFile(join(directory, ...file.path.split('/')))
      }))
  )
}

/** Lays a value out as the archive holds it, for the archive writer: these bytes and nothing else. */
export async function writeContentFolder(
  content: BotPackageContent,
  directory: string
): Promise<void> {
  const write = async (path: string, bytes: string | Buffer) => {
    const target = join(directory, ...path.split('/'))
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, bytes, { mode: 0o600 })
  }
  await write(BOT_PACKAGE_MANIFEST_PATH, `${JSON.stringify(content.bot, null, 2)}\n`)
  for (const file of content.files) {
    await write(file.path, file.text)
  }
  if (content.avatarBase64) {
    await write(BOT_PACKAGE_AVATAR_PATH, Buffer.from(content.avatarBase64, 'base64'))
  }
}
