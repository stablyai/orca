import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { LocalUsageHistoryStore } from './store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  )
})

it('returns only the requested custom Gemini interval after scanning local history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-gemini-usage-store-'))
  temporaryDirectories.push(root)
  await mkdir(root, { recursive: true })
  await writeFile(
    join(root, 'session.jsonl'),
    [
      {
        type: 'gemini',
        timestamp: '2026-07-11T10:00:00.000Z',
        tokens: { input: 2, output: 3, total: 5 }
      },
      {
        type: 'gemini',
        timestamp: '2026-07-12T10:00:00.000Z',
        tokens: { input: 5, output: 8, total: 13 }
      }
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')
  )
  const store = new LocalUsageHistoryStore('gemini', {
    sourceRoot: () => root,
    usageFilePath: join(root, 'usage.json')
  })

  await store.setEnabled(true)
  const result = await store.getHourly({ startDay: '2026-07-12', endDay: '2026-07-12' })

  expect(result.scanState.enabled).toBe(true)
  expect(result.points).toHaveLength(1)
  expect(result.points[0]).toMatchObject({ day: '2026-07-12', totalTokens: 13 })
})
