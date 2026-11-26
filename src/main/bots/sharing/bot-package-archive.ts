// A shared bot's archive: a transport manifest naming and hashing every file, then the files, written
// and read with the skill package tar functions. Only the parts a bot package may hold are placed.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BOT_AVATAR_FILE, isBotAvatarImage } from '../../../shared/bot-avatar'
import {
  BOT_PACKAGE_MANIFEST_PATH,
  botPackagePartOf,
  botPackageRole,
  parseBotPackage,
  type BotPackageV1
} from '../../../shared/bots/bot-package'
import {
  extractFile,
  readJsonEntry,
  requireArchiveEnd
} from '../../skills/bundle-archive/skill-bundle-extraction'
import { renameSkillPathWithWindowsRetry } from '../../skills/filesystem/skill-windows-rename-retry'
import { observeSkillPackage } from '../../skills/package-archive/skill-package-identity'
import {
  openSkillTarGzip,
  parseSkillTarHeader,
  writeSkillTarGzip,
  type SkillTarWriteEntry
} from '../../skills/package-archive/skill-package-tar'
import { USTAR_BLOCK_BYTES as SKILL_TAR_BLOCK_BYTES } from '../../archive/ustar-entry-header'
import {
  BOT_TRANSPORT_MANIFEST_PATH,
  botPackageDigest,
  compareCodeUnits,
  parseBotTransportManifest,
  skillFrontmatterName,
  type BotTransportFile,
  type BotTransportManifest
} from './bot-package-transport'

/** The extracted files are exactly the inventory, each with the identity the digest was taken over;
 *  the avatar is a real avatar image, and each skill's SKILL.md names its folder. */
async function verifyExtracted(directory: string, transport: BotTransportManifest): Promise<void> {
  const executables = transport.files.filter((file) => file.executable).map((file) => file.path)
  const observed = await observeSkillPackage(
    directory,
    undefined,
    process.platform === 'win32' ? new Set(executables) : undefined
  )
  const files = [...observed.files].sort((left, right) => compareCodeUnits(left.path, right.path))
  if (
    files.length !== transport.files.length ||
    files.some((file, index) => {
      const expected = transport.files[index]
      return (
        file.path !== expected.path ||
        file.exactSha256 !== expected.sha256 ||
        file.identitySha256 !== expected.identitySha256 ||
        file.classification !== expected.classification ||
        file.executable !== expected.executable
      )
    })
  ) {
    throw new Error('bot-package-identity-mismatch')
  }
  for (const file of transport.files) {
    const part = botPackagePartOf(file.path)
    if (
      part?.role === 'avatar' &&
      !isBotAvatarImage(await readFile(join(directory, BOT_AVATAR_FILE)))
    ) {
      throw new Error('bot-package-avatar-invalid')
    }
    if (
      part?.role === 'skill' &&
      part.path === 'SKILL.md' &&
      skillFrontmatterName(await readFile(join(directory, ...file.path.split('/')), 'utf8')) !==
        part.name
    ) {
      throw new Error('bot-package-skill-name-mismatch')
    }
  }
}

/** bot.json must declare exactly the parts the inventory carries. */
function requireDeclaredParts(bot: BotPackageV1, files: readonly BotTransportFile[]): void {
  const carried = new Set(files.map((file) => file.role))
  const declared = new Set([
    'manifest',
    'soul',
    ...bot.skills.map((skill) => `skill:${skill.name}`),
    ...bot.memory.map(() => 'memory'),
    ...(bot.avatar && 'image' in bot.avatar ? ['avatar'] : [])
  ])
  const memoryFiles = files.filter((file) => file.role === 'memory').map((file) => file.path)
  const declaredMemory = bot.memory.map((note) => `memory/${note.topic}.md`)
  if (
    carried.size !== declared.size ||
    [...carried].some((role) => !declared.has(role)) ||
    memoryFiles.length !== declaredMemory.length ||
    declaredMemory.some((path) => !memoryFiles.includes(path)) ||
    bot.skills.some((skill) => !files.some((file) => file.path === `skills/${skill.name}/SKILL.md`))
  ) {
    throw new Error('bot-package-undeclared-part')
  }
}

export type ReadBotPackage = {
  transport: BotTransportManifest
  bot: BotPackageV1
  droppedKeys: string[]
  archiveSha256: string
  compressedBytes: number
}

/** Unpacks an archive into a new folder: each declared file, its hash checked, nothing else. */
export async function readBotPackageArchive(input: {
  archivePath: string
  destinationDirectory: string
  expected?: {
    packageId?: string
    versionId?: string
    botDigest?: string
    archiveSha256?: string
  }
}): Promise<ReadBotPackage> {
  const archive = await openSkillTarGzip(input.archivePath)
  let created = false
  try {
    await mkdir(input.destinationDirectory, { mode: 0o700 })
    created = true
    const transport = parseBotTransportManifest(
      await readJsonEntry(archive.reader, BOT_TRANSPORT_MANIFEST_PATH)
    )
    const expected = input.expected ?? {}
    if (
      (expected.packageId && expected.packageId !== transport.packageId) ||
      (expected.versionId && expected.versionId !== transport.versionId) ||
      (expected.botDigest && expected.botDigest !== transport.botDigest)
    ) {
      throw new Error('bot-package-identity-mismatch')
    }
    for (const file of transport.files) {
      const header = parseSkillTarHeader(await archive.reader.readExact(SKILL_TAR_BLOCK_BYTES))
      if (
        !header ||
        header.path !== file.path ||
        header.size !== file.size ||
        header.executable !== file.executable
      ) {
        throw new Error('bot-package-file-envelope-mismatch')
      }
      await extractFile(
        archive.reader,
        join(input.destinationDirectory, ...file.path.split('/')),
        file
      )
    }
    await requireArchiveEnd(archive.reader)
    const identity = await archive.archiveIdentity
    if (expected.archiveSha256 && expected.archiveSha256 !== identity.archiveSha256) {
      throw new Error('bot-package-archive-digest-mismatch')
    }
    await verifyExtracted(input.destinationDirectory, transport)
    let value: unknown
    try {
      value = JSON.parse(
        await readFile(
          join(input.destinationDirectory, ...BOT_PACKAGE_MANIFEST_PATH.split('/')),
          'utf8'
        )
      )
    } catch {
      throw new Error('bot-package-invalid')
    }
    const { bot, droppedKeys } = parseBotPackage(value)
    if (bot.name !== transport.displayName) {
      throw new Error('bot-package-identity-mismatch')
    }
    requireDeclaredParts(bot, transport.files)
    return { transport, bot, droppedKeys, ...identity }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    archive.abort(failure)
    await archive.archiveIdentity.catch(() => undefined)
    if (created) {
      await rm(input.destinationDirectory, { recursive: true, force: true })
    }
    throw failure
  }
}

export type WrittenBotPackage = {
  transport: BotTransportManifest
  archivePath: string
  archiveSha256: string
  compressedBytes: number
}

/** Packs a folder laid out as the archive (bot.json, SOUL.md, skills/, memory/, avatar.png), then
 *  reads it back the way a recipient does before keeping it. */
export async function writeBotPackageArchive(input: {
  contentDirectory: string
  archivePath: string
  packageId: string
  versionId: string
  name: string
  displayName: string
  description: string
  createdAt?: string
}): Promise<WrittenBotPackage> {
  const observed = await observeSkillPackage(
    input.contentDirectory,
    undefined,
    undefined,
    undefined,
    process.platform,
    process.platform === 'win32'
  )
  const files = [...observed.files]
    .sort((left, right) => compareCodeUnits(left.path, right.path))
    .map((file) => {
      const part = botPackagePartOf(file.path)
      if (!part) {
        throw new Error('bot-package-path-not-allowed')
      }
      return {
        path: file.path,
        size: file.size,
        executable: file.executable,
        classification: file.classification,
        sha256: file.exactSha256,
        identitySha256: file.identitySha256,
        role: botPackageRole(part)
      }
    })
  const transport = parseBotTransportManifest({
    schemaVersion: 1,
    kind: 'bot',
    packageId: input.packageId,
    versionId: input.versionId,
    name: input.name,
    displayName: input.displayName,
    description: input.description,
    createdAt: input.createdAt ?? new Date().toISOString(),
    files,
    botDigest: botPackageDigest(files)
  })
  const manifestBytes = Buffer.from(JSON.stringify(transport), 'utf8')
  const entries: SkillTarWriteEntry[] = [
    {
      path: BOT_TRANSPORT_MANIFEST_PATH,
      size: manifestBytes.length,
      executable: false,
      bytes: manifestBytes
    },
    ...transport.files.map((file) => ({
      path: file.path,
      size: file.size,
      executable: file.executable,
      sourcePath: join(input.contentDirectory, ...file.path.split('/'))
    }))
  ]
  const temporary = `${input.archivePath}.${process.pid}.${randomUUID()}.tmp`
  const verification = `${input.archivePath}.${randomUUID()}.verify`
  try {
    await mkdir(dirname(input.archivePath), { recursive: true })
    const identity = await writeSkillTarGzip(temporary, entries)
    await readBotPackageArchive({
      archivePath: temporary,
      destinationDirectory: verification,
      expected: { botDigest: transport.botDigest, archiveSha256: identity.archiveSha256 }
    })
    await renameSkillPathWithWindowsRetry(temporary, input.archivePath)
    return { transport, archivePath: input.archivePath, ...identity }
  } finally {
    await rm(verification, { recursive: true, force: true })
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}
