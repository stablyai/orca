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

  it('does not stat directory links beyond the depth bound but still follows in-bound links', async () => {
    const base = await makeTree()
    const root = join(base, 'skills')
    const edge = join(root, 'a', 'b', 'c', 'd')
    const target = join(base, 'linked')
    await writeFileAt(join(edge, 'SKILL.md'))
    await writeFileAt(join(target, 'SKILL.md'))
    for (let index = 0; index < 32; index += 1) {
      await symlink(
        target,
        join(edge, `link${index.toString().padStart(2, '0')}`),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    }
    const statPaths: string[] = []
    onStat = async (path) => {
      statPaths.push(path)
    }

    expect(await findSkillFiles(root, 4)).toEqual([join(edge, 'SKILL.md')])
    expect(statPaths).toEqual([])
    // readdir order varies across NTFS/APFS/ext4; assert membership because 32 realpath-equivalent links collapse to whichever is visited first.
    const withinDepth = await findSkillFiles(root, 5)
    expect(withinDepth).toContain(join(edge, 'SKILL.md'))
    expect(withinDepth.filter((path) => /[\\/]link\d{2}[\\/]SKILL\.md$/.test(path))).toHaveLength(1)
    expect(withinDepth).toHaveLength(2)
    expect(statPaths).toHaveLength(32)
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

  // Abort inside the last symlink's stat so only nested propagation can catch it; broken-link handling must not swallow it as successful truncation.
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

  // Partial cached results would falsely report missing skills from a merely slow root.
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
