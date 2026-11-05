import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearKimiSessionIndexCache,
  readKimiWorkDirBySessionId
} from './session-scanner-kimi-paths'
let tempDirs: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  clearKimiSessionIndexCache()
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('Kimi session index reader cache', () => {
  it('reloads a grown index after its mtime is restored', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-kimi-index-mutation-'))
    tempDirs.push(root)
    const indexPath = join(root, 'session_index.jsonl')
    await writeFile(indexPath, `${JSON.stringify({ sessionId: 'session-old', workDir: '/old' })}\n`)
    const originalStat = await stat(indexPath)

    await expect(readKimiWorkDirBySessionId(indexPath)).resolves.toEqual(
      new Map([['session-old', '/old']])
    )
    await writeFile(
      indexPath,
      `${JSON.stringify({ sessionId: 'session-old', workDir: '/old' })}\n${JSON.stringify({ sessionId: 'session-new', workDir: '/new' })}\n`
    )
    await utimes(indexPath, originalStat.atime, originalStat.mtime)

    await expect(readKimiWorkDirBySessionId(indexPath)).resolves.toEqual(
      new Map([
        ['session-old', '/old'],
        ['session-new', '/new']
      ])
    )
  })
})
