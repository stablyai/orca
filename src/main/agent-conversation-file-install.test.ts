import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as FsPromises from 'node:fs/promises'

const renameFailures: string[] = []
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      const code = renameFailures.shift()
      if (code) {
        throw Object.assign(new Error(`${code}: rename`), { code })
      }
      return actual.rename(from, to)
    })
  }
})

const { refreshConversationFileCopy } = await import('./agent-conversation-file-install')

describe('refreshConversationFileCopy', () => {
  let root: string
  let source: string
  let target: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-conversation-refresh-'))
    source = join(root, 'source.jsonl')
    target = join(root, 'target.jsonl')
    writeFileSync(source, 'turn 1\nturn 2\n')
    writeFileSync(target, 'turn 1\n')
  })

  afterEach(() => {
    renameFailures.length = 0
    rmSync(root, { recursive: true, force: true })
  })

  it('rides out one busy rename, as Windows reports while a reader holds the file', async () => {
    renameFailures.push('EBUSY')
    await refreshConversationFileCopy(source, target)
    expect(readFileSync(target, 'utf8')).toBe('turn 1\nturn 2\n')
  })

  it('gives up after the retry and leaves the old copy whole', async () => {
    renameFailures.push('EPERM', 'EPERM')
    await expect(refreshConversationFileCopy(source, target)).rejects.toThrow('EPERM')
    expect(readFileSync(target, 'utf8')).toBe('turn 1\n')
  })

  it('does not retry other failures', async () => {
    renameFailures.push('EXDEV', 'EBUSY')
    await expect(refreshConversationFileCopy(source, target)).rejects.toThrow('EXDEV')
    expect(renameFailures).toEqual(['EBUSY'])
  })
})
