import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PaneSkillDiscoveryTargetSchema,
  parseSkillDiscoveryResult,
  SKILL_DISCOVERY_LIMITS
} from '../../shared/skills'
import { discoverSkills } from './discovery'

describe('skill discovery wire contract', () => {
  it('accepts pane identities containing a valid long workspace path', () => {
    const worktreeId = `repo-1::/${'nested/'.repeat(100)}repo`

    expect(worktreeId.length).toBeGreaterThan(512)
    expect(() => PaneSkillDiscoveryTargetSchema.parse({ worktreeId })).not.toThrow()
  })

  it('bounds scanner metadata before returning it to an SSH client', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skills-'))
    const home = join(root, 'home')
    const skillDir = join(home, '.agents', 'skills', 'oversized')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${'n'.repeat(SKILL_DISCOVERY_LIMITS.nameLength + 1)}\ndescription: ${'d'.repeat(SKILL_DISCOVERY_LIMITS.descriptionLength + 1)}\n---\n`
    )

    const result = await discoverSkills({ homeDir: home, repos: [], includeCwd: false })
    const discovered = result.skills.find((entry) => entry.directoryPath === skillDir)

    expect(discovered?.name).toHaveLength(SKILL_DISCOVERY_LIMITS.nameLength)
    expect(discovered?.description).toHaveLength(SKILL_DISCOVERY_LIMITS.descriptionLength)
    expect(() => parseSkillDiscoveryResult(result)).not.toThrow()
  })
})
