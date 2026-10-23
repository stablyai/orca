import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSkillDiscoverySources, discoverSkills } from './discovery'

describe('Antigravity global skill discovery', () => {
  it('attributes a skill in the CLI configuration directory to Antigravity', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orca-agy-skills-'))
    try {
      const root = join(home, '.gemini', 'config', 'skills')
      const directory = join(root, 'review')
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'SKILL.md'),
        '---\nname: review\ndescription: Review a change.\n---\n'
      )
      const result = await discoverSkills({
        homeDir: home,
        includeCwd: false,
        providerRootOverrides: {}
      })
      expect(result.skills.find((skill) => skill.name === 'review')?.rootPaths).toContain(root)
      expect(result.sources.find((source) => source.id === 'home-antigravity')).toMatchObject({
        path: root,
        owner: 'antigravity',
        exists: true
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it.each([
    { pathApi: posix, home: '/home/remote', expected: '/home/remote/.gemini/config/skills' },
    {
      pathApi: win32,
      home: 'C:\\Users\\remote',
      expected: 'C:\\Users\\remote\\.gemini\\config\\skills'
    }
  ])('uses the execution host path format: $expected', ({ pathApi, home, expected }) => {
    const roots = buildSkillDiscoverySources({ homeDir: home, pathApi, includeCwd: false })
    expect(roots.find((root) => root.id === 'home-antigravity')).toMatchObject({
      path: expected,
      owner: 'antigravity'
    })
  })
})
