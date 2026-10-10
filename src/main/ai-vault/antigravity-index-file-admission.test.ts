import type * as NodeFsPromises from 'node:fs/promises'
import { constants } from 'node:fs'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'

const { afterStat } = vi.hoisted(() => {
  const afterStat: { run: null | (() => Promise<void>) } = { run: null }
  return { afterStat }
})
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof NodeFsPromises>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const result = await actual.stat(...args)
      await afterStat.run?.()
      return result
    }
  }
})
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { readLocalAntigravityHistory } from './session-scanner-antigravity-history'
import { readRelayTranscriptBytes } from '../../relay/ai-vault-transcript-stream'

const roots: string[] = []
async function filePath() {
  const root = await mkdtemp(join(tmpdir(), 'orca-regular-index-'))
  roots.push(root)
  return join(root, 'projects.json')
}
async function fifo(path: string) {
  const result = await runProcess({ program: 'mkfifo', args: [path], timeoutMs: 2000 })
  if (result.code !== 0) {
    throw new Error('Could not create task-owned FIFO')
  }
}
afterEach(async () => {
  afterStat.run = null
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('bounded regular metadata reads', () => {
  it.skipIf(process.platform === 'win32')(
    'rejects real FIFO paths and symlinks without waiting for a writer',
    async () => {
      const file = await filePath()
      await fifo(file)
      const alias = `${file}.link`
      await symlink(file, alias)
      for (const path of [file, alias]) {
        expect(await readLocalAntigravityHistory(path)).toBeNull()
        await expect(readNodeFileWithinLimit(path, 64, { regularFileOnly: true })).rejects.toThrow(
          'regular file'
        )
        await expect(
          readRelayTranscriptBytes(path, undefined, { regularFileOnly: true, maxBytes: 64 }).next()
        ).rejects.toThrow('regular file')
      }
    },
    2000
  )

  it.skipIf(process.platform === 'win32')(
    'rejects a regular path replaced by a FIFO between stat and open',
    async () => {
      const file = await filePath()
      await writeFile(file, '{}')
      afterStat.run = async () => {
        afterStat.run = null
        await rm(file)
        await fifo(file)
      }
      await expect(readNodeFileWithinLimit(file, 64, { regularFileOnly: true })).rejects.toThrow(
        'regular file'
      )
      expect(constants.O_NONBLOCK).toBeGreaterThan(0)
    },
    2000
  )

  it('retains ordinary metadata and regular-file symlinks within the byte bound', async () => {
    const file = await filePath()
    await writeFile(file, '{"project":"/workspace"}')
    expect(await readLocalAntigravityHistory(file)).toBe('{"project":"/workspace"}')
    await expect(readNodeFileWithinLimit(file, 1, { regularFileOnly: true })).rejects.toThrow(
      'File too large'
    )
  })

  it('rejects growth beyond the bound after admission', async () => {
    const file = await filePath()
    await writeFile(file, '{}')
    afterStat.run = async () => {
      afterStat.run = null
      await writeFile(file, 'x'.repeat(65))
    }
    await expect(readNodeFileWithinLimit(file, 64, { regularFileOnly: true })).rejects.toThrow(
      'File too large'
    )
  })

  it('propagates cancellation before open and after admission', async () => {
    const file = await filePath()
    await writeFile(file, '{}')
    const controller = new AbortController()
    controller.abort()
    await expect(readLocalAntigravityHistory(file, controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    const next = new AbortController()
    afterStat.run = async () => {
      afterStat.run = null
      next.abort()
    }
    await expect(readLocalAntigravityHistory(file, next.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
  })
})
