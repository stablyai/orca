// The raw files a package value is built from (a bot's home, or a verified archive), and the folder an
// archive is packed from. Path, size, depth and link checks stay here, with the readers that own them.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  BOT_PACKAGE_AVATAR_PATH,
  BOT_PACKAGE_MANIFEST_PATH,
  BOT_PACKAGE_SOUL_PATH,
  type BotPackageV1
} from '../../../shared/bots/bot-package'
import { observeSkillPackage } from '../../skills/package-archive/skill-package-identity'
import type { BotPackageContent, BotPackageRawFile } from './bot-package-content'
import type { BotTransportManifest } from './bot-package-transport'
import type { BotShareable } from './bot-share-sources'

/** The picked parts of a bot's home, as they are now. A skill folder is read through the skill
 *  package observer, which refuses links and holds the size and depth limits. */
export async function sharerRawFiles(
  shareable: BotShareable,
  bot: BotPackageV1
): Promise<BotPackageRawFile[]> {
  const files: BotPackageRawFile[] = [
    { path: BOT_PACKAGE_SOUL_PATH, bytes: Buffer.from(shareable.soul, 'utf8') }
  ]
  if (shareable.avatarImage && bot.avatar && 'image' in bot.avatar) {
    files.push({ path: BOT_PACKAGE_AVATAR_PATH, bytes: shareable.avatarImage })
  }
  for (const { name } of bot.skills) {
    const skill = shareable.skills.find((entry) => entry.name === name)
    if (!skill) {
      continue
    }
    const observed = await observeSkillPackage(skill.directory)
    for (const file of observed.files) {
      files.push({
        path: `skills/${name}/${file.path}`,
        bytes: await readFile(join(skill.directory, ...file.path.split('/')))
      })
    }
  }
  for (const { topic } of bot.memory) {
    const note = shareable.memory.find((entry) => entry.topic === topic)
    if (note) {
      files.push({ path: `memory/${topic}.md`, bytes: await readFile(note.path) })
    }
  }
  return files
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
