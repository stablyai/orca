import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type * as SkillMetadata from '../../shared/skill-metadata'

const summarizeSkillMarkdown = vi.hoisted(() => vi.fn())

vi.mock('../../shared/skill-metadata', async (importOriginal) => {
  const original = await importOriginal<typeof SkillMetadata>()
  return {
    ...original,
    summarizeSkillMarkdown: (markdown: string) => {
      summarizeSkillMarkdown(markdown)
      return original.summarizeSkillMarkdown(markdown)
    }
  }
})

import { discoverSkills } from './discovery'

describe('native skill source filtering', () => {
  it('serves home and bundled filters from one raw root observation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-source-filter-'))
    const homeSkill = join(root, '.codex', 'skills', 'home-skill')
    const bundledSkill = join(root, '.codex', 'skills', '.system', 'bundled-skill')
    await mkdir(homeSkill, { recursive: true })
    await mkdir(bundledSkill, { recursive: true })
    await writeFile(join(homeSkill, 'SKILL.md'), '# Home Skill\n')
    await writeFile(join(bundledSkill, 'SKILL.md'), '# Bundled Skill\n')

    try {
      const result = await discoverSkills({ homeDir: root, repos: [], sourceKinds: ['home'] })

      expect(result.skills.map((skill) => skill.name)).toEqual(['Home Skill'])
      expect(summarizeSkillMarkdown).toHaveBeenCalledTimes(2)
      expect(summarizeSkillMarkdown).toHaveBeenCalledWith('# Home Skill\n')
      const bundled = await discoverSkills({ homeDir: root, repos: [], sourceKinds: ['bundled'] })
      expect(bundled.skills.map((skill) => skill.name)).toEqual(['Bundled Skill'])
      expect(summarizeSkillMarkdown).toHaveBeenCalledTimes(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
