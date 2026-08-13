import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findSkillFiles } from './skill-root-file-walk'

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
})
