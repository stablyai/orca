import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findSkillFiles } from '../skill-root-file-walk'
import { skillDeleteStagedName } from './staging-names'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function stagedRoot(stagedName: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-staging-visibility-'))
  roots.push(root)
  const staged = join(root, stagedName)
  await mkdir(staged, { recursive: true })
  await writeFile(join(staged, 'SKILL.md'), '---\nname: demo\n---\n')
  return root
}

describe('native walker', () => {
  it.each([
    skillDeleteStagedName('demo', 'id'),
    '.demo.orca-remove-backup-id',
    '.demo.orca-placement-backup-id'
  ])('does not surface a %s staged directly in a scanned root', async (stagedName) => {
    const root = await stagedRoot(stagedName)
    expect(await findSkillFiles(root, 4)).toEqual([])
  })

  it('still finds an ordinary skill beside a staged one', async () => {
    const root = await stagedRoot(skillDeleteStagedName('demo', 'id'))
    const real = join(root, 'demo')
    await mkdir(real)
    await writeFile(join(real, 'SKILL.md'), '---\nname: demo\n---\n')
    expect(await findSkillFiles(root, 4)).toEqual([join(real, 'SKILL.md')])
  })
})
