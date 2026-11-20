import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findSkillFiles } from './skill-root-file-walk'
import { isSkillRootUnavailableError } from './skill-scan-coalescer'

/** Set by a test to run at a chosen point inside the walk; cleared after each. */
let onStat: ((path: string) => Promise<void>) | null = null

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    stat: async (path: string, ...rest: unknown[]) => {
      const result = await (actual.stat as (...args: unknown[]) => Promise<unknown>)(path, ...rest)
      await onStat?.(path)
      return result
    }
  }
})

afterEach(() => {
  onStat = null
})

async function makeTree(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'orca-skill-walk-'))
}

async function writeFileAt(path: string, content = 'x'): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

describe('findSkillFiles', () => {
  // Pin real AbortError naming: discovery relies on it to classify unavailable roots.
  it('stops walking once its signal aborts, rejecting with an AbortError', async () => {
    const root = join(await makeTree(), 'skills')
    await writeFileAt(join(root, 'one', 'SKILL.md'))
    await writeFileAt(join(root, 'two', 'SKILL.md'))

    const walk = findSkillFiles(root, 4, AbortSignal.abort())

    await expect(walk).rejects.toMatchObject({ name: 'AbortError' })
    await expect(walk).rejects.toBeInstanceOf(Error)
    expect(isSkillRootUnavailableError(await walk.catch((error: unknown) => error))).toBe(true)
  })
})
