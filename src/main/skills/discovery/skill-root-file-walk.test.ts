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
  it('finds packages inside the depth bound and ignores deeper ones', async () => {
    const root = join(await makeTree(), 'skills')
    await writeFileAt(join(root, 'near', 'SKILL.md'))
    await writeFileAt(join(root, 'a', 'b', 'c', 'd', 'far', 'SKILL.md'))

    const found = await findSkillFiles(root, 4)

    expect(found).toEqual([join(root, 'near', 'SKILL.md')])
  })

  it('returns nothing for a missing root rather than throwing', async () => {
    expect(await findSkillFiles(join(await makeTree(), 'absent'), 4)).toEqual([])
  })

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
