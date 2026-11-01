import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { writeCodexHistoryFixture } from './codex-history-test-fixture'
import { prepareLegacyTranscriptImport } from './journal-legacy-import'

const PARENT = '01a17c7f-6f58-7a73-b87a-a8702ff2da17'
const CHILD = '01a17c81-30d1-72f0-b84e-002ddfe6fd47'
const MIDDLE = '01a17c80-30d1-72f0-b84e-002ddfe6fd47'
let root: string
beforeEach(async () => {
  const account = await mkdtemp(join(tmpdir(), 'orca-codex-lineage-'))
  root = join(account, 'sessions')
  await mkdir(root)
  await mkdir(join(account, 'archived_sessions'))
})
afterEach(async () => {
  await rm(dirname(root), { recursive: true, force: true })
})

function request(filePath: string) {
  return {
    agent: 'codex' as const,
    sessionId: CHILD,
    options: {
      filePath,
      codexSessionsDirs: [root],
      source: { providerSessionId: CHILD, workspaceCwd: '/workspace' }
    }
  }
}

it.each(['active', 'archive', 'compressed'] as const)(
  'imports %s ancestor prefixes oldest first and excludes later turns',
  async (location) => {
    const parent = await writeCodexHistoryFixture(root, PARENT, ['sky'], undefined, MIDDLE)
    const middle = await writeCodexHistoryFixture(root, MIDDLE, ['leaves'], parent.position)
    const child = await writeCodexHistoryFixture(root, CHILD, ['ice'], middle.position)
    const later = await writeCodexHistoryFixture(root, '01a17c82-30d1-72f0-b84e-002ddfe6fd47', [
      'S1'
    ])
    await appendFile(
      parent.filePath,
      `${later.records
        .slice(1)
        .map((record, index) =>
          JSON.stringify({ ...record, ordinal: parent.position.end_ordinal_exclusive + index })
        )
        .join('\n')}\n`
    )
    if (location !== 'active') {
      const archived = join(dirname(root), 'archived_sessions', basename(parent.filePath))
      if (location === 'compressed') {
        await writeFile(`${archived}.zst`, zstdCompressSync(await readFile(parent.filePath)))
        await rm(parent.filePath)
      } else {
        await rename(parent.filePath, archived)
      }
    }
    const result = await prepareLegacyTranscriptImport(request(child.filePath))
    expect(result.ok && result.items.map((item) => item.body)).toMatchObject([
      { blocks: [{ text: 'sky' }] },
      { blocks: [{ text: 'sky answer' }] },
      { blocks: [{ text: 'leaves' }] },
      { blocks: [{ text: 'leaves answer' }] },
      { blocks: [{ text: 'ice' }] },
      { blocks: [{ text: 'ice answer' }] }
    ])
  }
)
