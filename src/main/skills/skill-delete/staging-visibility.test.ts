import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildWslSkillDiscoveryCommand } from '../skill-discovery-wsl'
import { findSkillFiles } from '../skill-root-file-walk'
import { isSkillStagingEntryName, skillDeleteStagedName, SKILL_STAGING_GLOB } from './staging-names'

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

describe('isSkillStagingEntryName', () => {
  it.each([
    '.demo.orca-skill-delete-1234',
    '.demo.orca-remove-backup-1234',
    '.demo.orca-placement-backup-1234',
    '.demo.orca-placement-staging-1234'
  ])('matches the %s convention', (name) => {
    expect(isSkillStagingEntryName(name)).toBe(true)
  })

  it.each(['demo', '.hidden-skill', '..cache', '.orca'])('leaves %s alone', (name) => {
    expect(isSkillStagingEntryName(name)).toBe(false)
  })
})

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

describe('WSL guest scan', () => {
  it('prunes the same staging shapes the native walker skips', () => {
    // The runner receives the script directly, so assert on its find expression.
    const command = buildWslSkillDiscoveryCommand([
      {
        id: 'home-agents',
        label: 'Agent skills home',
        path: '/home/u/.agents/skills',
        sourceKind: 'home',
        providers: ['agent-skills'],
        owner: null
      }
    ])
    expect(command).toContain(`-name '${SKILL_STAGING_GLOB}' -prune`)
    // The prune must gate the print, not sit beside it.
    expect(command).toContain("-prune \\) -o \\( -type f -name 'SKILL.md' -print0 \\)")
  })
})
