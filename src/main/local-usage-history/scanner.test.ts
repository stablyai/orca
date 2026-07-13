import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanLocalUsageHistory } from './scanner'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  )
})

async function makeTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'orca-local-usage-history-'))
  temporaryDirectories.push(path)
  return path
}

describe('scanLocalUsageHistory', () => {
  it('projects Gemini JSON and JSONL token records into local hourly buckets', async () => {
    const root = await makeTemporaryDirectory()
    await writeFile(
      join(root, 'session.json'),
      JSON.stringify({
        messages: [
          {
            type: 'gemini',
            timestamp: '2026-07-12T18:02:00.000Z',
            tokens: { input: 10, cached: 2, output: 4, thoughts: 3, tool: 1, total: 20 }
          }
        ]
      })
    )
    await writeFile(
      join(root, 'session.jsonl'),
      `${JSON.stringify({
        type: 'gemini',
        timestamp: '2026-07-12T18:04:00.000Z',
        tokens: { input: 5, output: 5, total: 10 }
      })}\n`
    )

    const result = await scanLocalUsageHistory({
      provider: 'gemini',
      rootDir: root,
      previousFiles: []
    })

    expect(result.hourlyAggregates).toEqual([
      {
        day: '2026-07-12',
        hour: new Date('2026-07-12T18:02:00.000Z').getHours(),
        eventCount: 2,
        inputTokens: 15,
        cachedInputTokens: 2,
        outputTokens: 9,
        reasoningOutputTokens: 3,
        cacheWriteTokens: 0,
        toolTokens: 1,
        totalTokens: 30
      }
    ])
  })

  it('reads Kimi turn usage from wire logs and skips cumulative session records', async () => {
    const root = await makeTemporaryDirectory()
    const wireDirectory = join(root, 'wd_project', 'session_1', 'agents', 'main')
    await mkdir(wireDirectory, { recursive: true })
    await writeFile(
      join(wireDirectory, 'wire.jsonl'),
      [
        {
          type: 'usage.record',
          time: 1781805600000,
          usageScope: 'turn',
          usage: { inputOther: 10, inputCacheRead: 3, output: 4, inputCacheCreation: 2 }
        },
        {
          type: 'usage.record',
          time: 1781805600000,
          usageScope: 'session',
          usage: { inputOther: 999, inputCacheRead: 999, output: 999, inputCacheCreation: 999 }
        }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')
    )

    const result = await scanLocalUsageHistory({
      provider: 'kimi',
      rootDir: root,
      previousFiles: []
    })

    expect(result.hourlyAggregates).toHaveLength(1)
    expect(result.hourlyAggregates[0]).toMatchObject({
      eventCount: 1,
      inputTokens: 10,
      cachedInputTokens: 3,
      outputTokens: 4,
      cacheWriteTokens: 2,
      totalTokens: 19
    })
  })

  it('reuses unchanged file projections instead of reparsing them', async () => {
    const root = await makeTemporaryDirectory()
    await writeFile(
      join(root, 'session.jsonl'),
      `${JSON.stringify({
        type: 'gemini',
        timestamp: '2026-07-12T18:04:00.000Z',
        tokens: { input: 5, output: 5, total: 10 }
      })}\n`
    )
    const first = await scanLocalUsageHistory({
      provider: 'gemini',
      rootDir: root,
      previousFiles: []
    })
    const unchanged = await scanLocalUsageHistory({
      provider: 'gemini',
      rootDir: root,
      previousFiles: first.processedFiles
    })

    expect(unchanged.hourlyAggregates).toEqual(first.hourlyAggregates)
  })
})
