import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSkillDiscoverySources, discoverSkills } from './discovery'

describe('Antigravity CLI skill discovery', () => {
  it.each([
    { homeDir: '/home/agent', cwd: '/workspace', pathApi: posix },
    { homeDir: 'C:\\Users\\agent', cwd: 'D:\\workspace', pathApi: win32 }
  ])('uses the owning host path syntax for $homeDir', (args) => {
    expect(
      buildSkillDiscoverySources(args).find((root) => root.id === 'home-antigravity')
    ).toMatchObject({
      path: args.pathApi.join(args.homeDir, '.gemini', 'config', 'skills'),
      owner: 'antigravity',
      providers: ['agent-skills']
    })
  })

  it('discovers the documented CLI root without claiming legacy-only skills are loaded', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orca-agy-skills-'))
    try {
      for (const [directory, name] of [
        ['config', 'current-probe'],
        ['antigravity', 'legacy-probe']
      ]) {
        const skill = join(home, '.gemini', directory, 'skills', name)
        await mkdir(skill, { recursive: true })
        await writeFile(
          join(skill, 'SKILL.md'),
          `---\nname: ${name}\ndescription: Discovery test\n---\nTest skill.\n`
        )
      }
      const result = await discoverSkills({ homeDir: home, cwd: home, includeCwd: false })
      const agySkills = result.skills.filter((skill) => skill.sourceLabel === 'Antigravity home')
      expect(agySkills.map((skill) => skill.name)).toEqual(['current-probe'])
      expect(agySkills[0]?.rootPath).toBe(join(home, '.gemini', 'config', 'skills'))
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
