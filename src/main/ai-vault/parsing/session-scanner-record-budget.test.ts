import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../parse-cache/session-parse-cache-store'

import { codexFixture } from '../scanners/codex/session-scanner-codex-fixtures'
import { scanAiVaultSessions } from '../session-scanner'
import { isolatedScanRoots } from '../scanner-fixtures/session-scanner-test-fixtures'
import { MAX_SESSION_TRANSCRIPT_RECORD_BYTES } from '../transcripts/session-transcript-record-budget'
import { resetSessionParseCachePersistenceForTests } from '../parse-cache/session-parse-cache-persistence'

// One record past the budget, terminated separately so tests control the newline.
const OVERSIZED = Buffer.alloc(MAX_SESSION_TRANSCRIPT_RECORD_BYTES + 1, 'x')

let tempRoots: string[] = []

afterEach(async () => {
  resetSessionParseCachePersistenceForTests()
  resetSessionParseCacheForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

it('lists a recovered session without an issue on fresh and cached scans', async () => {
  const root = await tempRoot('orca-record-budget-scan-')
  const roots = isolatedScanRoots(root)
  const fixture = codexFixture()
  const dir = roots.codexSessionsDir
  const path = join(dir, fixture.fileName)

  await mkdir(dir, { recursive: true })
  await writeFile(path, `${fixture.seedLines.join('\n')}\n`)
  await appendFile(path, '{"type":"compacted","payload":{"message":"')
  await appendFile(path, OVERSIZED)
  await appendFile(path, `"}}\n${fixture.appendLines.join('\n')}\n`)

  for (let scan = 0; scan < 2; scan++) {
    const result = await scanAiVaultSessions(roots)
    const session = result.sessions.find((entry) => entry.filePath === path)
    expect(session?.previewMessages.map((message) => message.text)).toEqual([
      'codex seed question',
      'codex seed answer',
      'codex follow-up',
      'codex incremental answer'
    ])
    expect(result.issues).toEqual([])
  }
})
