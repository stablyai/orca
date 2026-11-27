import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { importClaudeTranscript } from './journal-claude-import'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'

const turn = (uuid: string, parentUuid: string | null, type = 'assistant') => ({
  type,
  uuid,
  parentUuid,
  message: { content: uuid }
})
const progress = (uuid: string, parentUuid: string | null) => ({
  type: 'progress',
  uuid,
  parentUuid
})

async function importedUuids(rows: readonly unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'orca-claude-ancestry-'))
  try {
    const filePath = join(root, 'session.jsonl')
    await writeFile(filePath, rows.map((row) => `${JSON.stringify(row)}\n`).join(''))
    const result = await importClaudeTranscript({
      filePath,
      agent: 'claude',
      sessionId: 'session',
      retainedBytes: 16 * 1024,
      limits: { inlineHeadBytes: 16 * 1024 }
    })
    try {
      await result.verify()
      return result.items.map((bytes) => {
        const item: JournalReplacementItem = JSON.parse(bytes.toString('utf8'))
        return item.identity.provider === 'claude' ? item.identity.uuid : null
      })
    } finally {
      await result.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'b', parentUuid: null }
const summary = {
  ...turn('s', 'b', 'user'),
  isCompactSummary: true
}

it.each([
  ['an orphaned summary', [boundary, { ...summary, parentUuid: 'missing' }]],
  ['a sidechain boundary', [{ ...boundary, isSidechain: true }, summary]],
  ['a cycle', [{ ...boundary, parentUuid: 's' }, summary]],
  ['an unselected boundary', [boundary, summary, { ...summary, uuid: 'other', parentUuid: null }]]
])('does not project a compaction notice for %s', async (_case, rows) => {
  await expect(importedUuids(rows)).resolves.toEqual([])
})

it('shows ordinary history when there is a visible turn after compaction', async () => {
  await expect(importedUuids([boundary, summary, turn('next', 's', 'user')])).resolves.toEqual([
    'next'
  ])
})

it.each([
  ['sidechain', { isSidechain: true }],
  ['team', { teamName: 'team-name' }]
])('keeps ancestry through a hidden %s row without displaying it', async (_kind, hidden) => {
  await expect(
    importedUuids([
      turn('u1', null, 'user'),
      turn('a1', 'u1'),
      { ...turn('hidden', 'a1'), ...hidden },
      turn('u2', 'hidden', 'user'),
      turn('a2', 'u2')
    ])
  ).resolves.toEqual(['u1', 'a1', 'u2', 'a2'])
})

const preservedSegment = {
  preservedSegment: { anchorUuid: 'b', headUuid: 'keep', tailUuid: 'keep' }
}
const preservedMessages = { preservedMessages: { anchorUuid: 'b', uuids: ['keep'] } }
it.each([
  ['sidechain segment', { isSidechain: true }, preservedSegment],
  ['sidechain list', { isSidechain: true }, preservedMessages],
  ['team segment', { teamName: 'team-name' }, preservedSegment],
  ['team list', { teamName: 'team-name' }, preservedMessages]
])(
  'rewires history through a hidden compact boundary with a %s',
  async (_case, hidden, compactMetadata) => {
    await expect(
      importedUuids([
        turn('old', null, 'user'),
        turn('keep', 'old'),
        {
          type: 'system',
          subtype: 'compact_boundary',
          uuid: 'b',
          parentUuid: null,
          ...hidden,
          compactMetadata
        },
        turn('u2', 'b', 'user'),
        turn('a2', 'u2')
      ])
    ).resolves.toEqual(['keep', 'u2', 'a2'])
  }
)

it('resolves compressed links through exact IDs, later duplicates, and forward parents', async () => {
  // These equal-length IDs collide under the index's hash.
  const duplicate = 'progress-0xp47bn'
  const collision = 'progress-0sb0sjy'
  const unpaired = '\uD800'
  await expect(
    importedUuids([
      turn('abandoned', null, 'user'),
      progress(duplicate, 'abandoned'),
      progress(unpaired, duplicate),
      progress('進捗🧭', unpaired),
      progress(duplicate, 'root'),
      turn('root', null, 'user'),
      progress(collision, 'abandoned'),
      progress('\uFFFD', 'abandoned'),
      turn('answer', '進捗🧭')
    ])
  ).resolves.toEqual(['root', 'answer'])
})

it('overrides the compressed parent of a progress row when a compact boundary preserves it', async () => {
  await expect(
    importedUuids([
      turn('old', null, 'user'),
      progress('progress-1', 'old'),
      progress('progress-2', 'progress-1'),
      turn('preserved', 'progress-2'),
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'boundary',
        parentUuid: null,
        compactMetadata: {
          preservedSegment: {
            anchorUuid: 'boundary',
            headUuid: 'progress-2',
            tailUuid: 'preserved'
          }
        }
      },
      turn('answer', 'boundary')
    ])
  ).resolves.toEqual(['preserved', 'answer'])
})
