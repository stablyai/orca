import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
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

  // The name is load-bearing, not incidental: `isSkillRootUnavailableError` matches
  // on it to decide whether a root degrades to `unavailable` or fails the discovery.
  // Callers elsewhere fabricate this shape, so this is the one place that pins a
  // real abort actually producing it.
  it('stops walking once its signal aborts, rejecting with an AbortError', async () => {
    const root = join(await makeTree(), 'skills')
    await writeFileAt(join(root, 'one', 'SKILL.md'))
    await writeFileAt(join(root, 'two', 'SKILL.md'))

    const walk = findSkillFiles(root, 4, AbortSignal.abort())

    await expect(walk).rejects.toMatchObject({ name: 'AbortError' })
    await expect(walk).rejects.toBeInstanceOf(Error)
    expect(isSkillRootUnavailableError(await walk.catch((error: unknown) => error))).toBe(true)
  })

  // The broken-link catch around the symlink branch must not swallow the abort a
  // nested visit throws, or the walk returns a truncated listing as success. The
  // abort has to land inside the symlink's stat — after the entry loop's check and
  // before the nested visit's — and the link must be the last entry, so nothing
  // afterwards re-checks the signal.
  it('propagates an abort thrown while following a symlinked directory', async () => {
    const base = await makeTree()
    const root = join(base, 'skills')
    await writeFileAt(join(base, 'linked', 'deep', 'SKILL.md'))
    await mkdir(root, { recursive: true })
    await symlink(
      join(base, 'linked'),
      join(root, 'via-link'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const controller = new AbortController()
    onStat = async (path) => {
      if (path.endsWith('via-link')) {
        controller.abort()
      }
    }

    await expect(findSkillFiles(root, 4, controller.signal)).rejects.toThrow()
  })

  // Why not a truncated list: a caller that cached one would publish "these skills
  // no longer exist" for a root that was merely slow.
  it('rejects rather than returning the entries it had already collected', async () => {
    const root = join(await makeTree(), 'skills')
    await writeFileAt(join(root, 'one', 'SKILL.md'))
    await writeFileAt(join(root, 'two', 'SKILL.md'))
    const controller = new AbortController()
    const walk = findSkillFiles(root, 4, controller.signal)
    controller.abort()

    await expect(walk).rejects.toThrow()
  })
})
