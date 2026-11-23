// A shared bot's package, written and read back through the real archive code, as a fetched link, and
// the recipient content a review of it keeps.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { readBotPackageArchive, writeBotPackageArchive } from './bot-package-archive'
import { buildBotPackageContent } from './bot-package-content'
import { archiveRawFiles } from './bot-package-content-files'
import type { FetchedSharedBot } from './bot-share-receive'
import { prepareRecipientContent, type BotRecipientContent } from './bot-share-recipient'

/** A real 512 px square PNG, all black. */
export function squarePng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(512, 0)
  header.writeUInt32BE(512, 4)
  header.set([8, 0, 0, 0, 0], 8)
  // Each row: filter byte 0, then 512 grey pixels.
  const rows = Buffer.alloc(512 * 513)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const BOT_JSON = {
  schemaVersion: 1,
  name: 'Release notes',
  avatar: { image: 'avatar.png' },
  purpose: 'Drafts release notes.',
  agentHint: 'claude',
  skills: [{ name: 'changelog-style' }],
  tools: [{ id: 't1', name: 'docs', url: 'https://mcp.example.com/mcp', headerNames: [] }],
  connectors: [{ kind: 'github' }],
  schedules: [
    {
      id: 's1',
      name: 'Weekday check',
      prompt: 'List merged PRs.',
      rrule: 'FREQ=DAILY;BYHOUR=9',
      results: 'chat'
    },
    {
      id: 's2',
      name: 'Friday digest',
      prompt: 'Sum up the week.',
      rrule: 'FREQ=WEEKLY;BYDAY=FR',
      results: 'chat'
    }
  ],
  eventSuggestions: [],
  memory: [{ topic: 'area-owners' }]
}

const FILES: Record<string, string | Buffer> = {
  'dev.orca.bot-sharing/bot.json': JSON.stringify(BOT_JSON),
  'SOUL.md': '# Release notes\n\nDrafts release notes.\n',
  'avatar.png': squarePng(),
  'skills/changelog-style/SKILL.md':
    '---\nname: changelog-style\ndescription: House style\nallowed-tools: Bash(*)\n---\nShort lines.\n',
  'memory/area-owners.md': 'Web: Dara\n'
}

const unique = (): string => Math.random().toString(36).slice(2)

/** The package a link serves, unpacked as fetchSharedBot leaves it; `files` adds or replaces files. */
export async function sharedPackage(
  root: string,
  files: Record<string, string | Buffer> = {}
): Promise<FetchedSharedBot & { archivePath: string }> {
  const content = join(root, `content-${unique()}`)
  for (const [path, text] of Object.entries({ ...FILES, ...files })) {
    await mkdir(join(content, path, '..'), { recursive: true })
    await writeFile(join(content, path), text)
  }
  const written = await writeBotPackageArchive({
    contentDirectory: content,
    archivePath: join(root, `${unique()}.tar.gz`),
    packageId: 'package-1',
    versionId: 'version-1',
    name: 'bot-1',
    displayName: 'Release notes',
    description: 'Drafts release notes.'
  })
  const directory = join(root, `read-${unique()}`)
  const read = await readBotPackageArchive({
    archivePath: written.archivePath,
    destinationDirectory: directory
  })
  return {
    shareId: 'share-1',
    version: {
      packageId: 'package-1',
      versionId: 'version-1',
      name: 'bot-1',
      description: 'Drafts release notes.',
      packageDigest: read.transport.botDigest,
      archiveSha256: read.archiveSha256,
      compressedBytes: read.compressedBytes,
      createdAt: '2026-11-08T00:00:00.000Z',
      manifest: { displayName: 'Release notes' },
      publisher: { displayName: 'Dara' },
      publishedAt: '2026-11-08T00:00:00.000Z'
    },
    read,
    directory,
    archivePath: written.archivePath,
    cleanup: async () => {}
  }
}

/** What a review of the fetched package keeps for Create. */
export async function reviewedContent(fetched: FetchedSharedBot): Promise<BotRecipientContent> {
  const { read, version } = fetched
  return prepareRecipientContent(
    buildBotPackageContent({
      bot: read.bot,
      files: await archiveRawFiles(fetched.directory, read.transport)
    }),
    {
      shareId: fetched.shareId,
      packageId: version.packageId,
      versionId: version.versionId,
      archiveSha256: read.archiveSha256,
      packageDigest: read.transport.botDigest,
      publisher: version.publisher.displayName,
      publishedAt: version.publishedAt
    },
    read.droppedKeys
  )
}
