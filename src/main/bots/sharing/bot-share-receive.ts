// A shared link, received: the version it serves now, downloaded and read through the archive reader,
// and the files of the reviewed content written into a new home.
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import * as z from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { planBotFromPackage, type BotPackagePlan } from '../../../shared/bots/bot-package'
import { BOT_SHARE_MEMORY_INDEX } from '../../../shared/bots/bot-share-received'
import { readBotPackageArchive, type ReadBotPackage } from './bot-package-archive'
import type { BotRecipientContent } from './bot-share-recipient'
import type { BotShareClient, BotShareMoved, BotSharedVersion } from './bot-share-client'

export type BotShareDownloadPolicy = {
  temporaryRoot: string
  allowedOrigins: readonly string[]
  requireHttps: boolean
  fetcher?: typeof fetch
}

/** A version of a shared bot, unpacked into `directory`; `cleanup` removes it. */
export type FetchedSharedBot = {
  shareId: string
  version: BotSharedVersion
  read: ReadBotPackage
  directory: string
  cleanup: () => Promise<void>
}

const GrantSchema = lazyZodSchema(() => z.object({ url: z.string(), expiresAt: z.string() }))

/** The version the link serves now, or `versionId` exactly. Moved when the link no longer serves
 *  `versionId`; null when it was stopped or never existed. */
export async function fetchSharedBot(
  client: BotShareClient,
  policy: BotShareDownloadPolicy,
  shareId: string,
  versionId?: string
): Promise<FetchedSharedBot | BotShareMoved | null> {
  let wanted = versionId
  if (!wanted) {
    const resolved = await client.resolveShare(shareId)
    if (!resolved || 'moved' in resolved) {
      return resolved
    }
    wanted = resolved.versionId
  }
  const granted = await client.downloadGrant(shareId, wanted)
  if (!granted || 'moved' in granted) {
    return granted
  }
  const { version } = granted
  const grant = GrantSchema.parse(granted.grant)
  const { downloadSkillPackageGrant } =
    await import('../../skills/package-download/skill-package-download')
  const downloaded = await downloadSkillPackageGrant({
    ...grant,
    expectedArchiveSha256: version.archiveSha256,
    expectedCompressedBytes: version.compressedBytes,
    temporaryRoot: policy.temporaryRoot,
    allowedOrigins: policy.allowedOrigins,
    requireHttps: policy.requireHttps,
    fetcher: policy.fetcher
  })
  const directory = await mkdtemp(join(policy.temporaryRoot, 'bot-share-'))
  try {
    const read = await readBotPackageArchive({
      archivePath: downloaded.archivePath,
      destinationDirectory: join(directory, 'content'),
      expected: {
        packageId: version.packageId,
        versionId: version.versionId,
        botDigest: version.packageDigest,
        archiveSha256: version.archiveSha256
      }
    })
    return {
      shareId,
      version,
      read,
      directory: join(directory, 'content'),
      cleanup: () => rm(directory, { recursive: true, force: true })
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  } finally {
    await downloaded.cleanup()
  }
}

/** A new home's received files exactly as reviewed, each where the plan puts it for the recipient's
 *  agent, over the starters its home was made with. */
export function recipientFiles(
  recipient: BotRecipientContent,
  plan: BotPackagePlan
): { to: string; text: string }[] {
  const memory = { from: BOT_SHARE_MEMORY_INDEX, to: BOT_SHARE_MEMORY_INDEX }
  return [...plan.files, memory].flatMap((file) => {
    const text = recipient.files.find((entry) => entry.path === file.from)?.text
    return text === undefined ? [] : [{ to: file.to, text }]
  })
}

/** The plan for a recipient's choices, over the reviewed files: the archive's are never read again. */
export function recipientPlan(
  recipient: BotRecipientContent,
  choice: Parameters<typeof planBotFromPackage>[2]
): BotPackagePlan {
  const inventory = recipient.files
    .filter((file) => file.path !== BOT_SHARE_MEMORY_INDEX)
    .map((file) => ({ path: file.path, executable: false }))
  return planBotFromPackage(recipient.bot, inventory, choice)
}
