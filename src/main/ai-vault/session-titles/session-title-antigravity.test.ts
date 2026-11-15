import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeJsonlFile } from '../scanner-fixtures/session-scanner-test-fixtures'
import { resetSessionParseCacheForTests } from '../parse-cache/session-parse-cache-store'
import { resetAntigravityMetadataTitleCacheForTests } from '../scanners/antigravity/session-scanner-antigravity-title-index'
import { readAiVaultSessionTitlesFromFiles } from './session-title-file-reader'

let tempRoot: string | undefined

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetAntigravityMetadataTitleCacheForTests()
  tempRoot = await mkdtemp(join(tmpdir(), 'orca-agy-title-'))
})

afterEach(async () => {
  resetSessionParseCacheForTests()
  resetAntigravityMetadataTitleCacheForTests()
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true })
    tempRoot = undefined
  }
})

describe('Antigravity AI Vault session titles', () => {
  it('upgrades from fallback transcript title to named metadata summary title', async () => {
    const sessionId = '11111111-2222-4333-8444-555555555555'
    const transcriptPath = join(
      tempRoot!,
      'brain',
      sessionId,
      '.system_generated',
      'logs',
      'transcript_full.jsonl'
    )
    await writeJsonlFile(transcriptPath, [
      {
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-05-01T10:00:00.000Z',
        content: '<USER_REQUEST>Draft launch plan</USER_REQUEST>'
      }
    ])

    const initial = await readAiVaultSessionTitlesFromFiles([
      { agent: 'antigravity', sessionId, transcriptPath }
    ])
    expect(initial).toEqual({
      titles: [
        {
          agent: 'antigravity',
          sessionId,
          title: 'Draft launch plan',
          kind: 'fallback'
        }
      ]
    })

    const cacheDir = join(tempRoot!, 'cache')
    await mkdir(cacheDir, { recursive: true })
    await writeFile(
      join(cacheDir, 'conversation_metadata.json'),
      JSON.stringify({
        conversations: {
          [sessionId]: {
            summary: { Title: 'Refactor Session Title Sync' }
          }
        }
      })
    )

    const upgraded = await readAiVaultSessionTitlesFromFiles([
      { agent: 'antigravity', sessionId, transcriptPath }
    ])
    expect(upgraded).toEqual({
      titles: [
        {
          agent: 'antigravity',
          sessionId,
          title: 'Refactor Session Title Sync',
          kind: 'named'
        }
      ]
    })
  })
})
