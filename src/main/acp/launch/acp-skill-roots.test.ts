import { describe, expect, it } from 'vitest'
import {
  loadGrokSkillRoots,
  loadOmpSkillRoots,
  loadOpenCodeSkillRoots,
  withOpenCodeSkillsPaths,
  type AcpSkillRootsInput
} from './acp-skill-roots'

const VISUALS = { pluginDir: '/app/plugin', skillsRoot: '/app/plugin/skills' }
// A team setup script's checkout: every skill is a link out of the folder.
const LINKED = {
  pluginDir: '/repo/.agents',
  skillsRoot: '/repo/.agents/skills',
  linksOut: true as const
}

function input(overrides: Partial<AcpSkillRootsInput> = {}): AcpSkillRootsInput {
  return { roots: [VISUALS, LINKED], version: null, env: {}, ...overrides }
}

describe('Grok skill roots', () => {
  it('passes plugin folders only on a release known to take --plugin-dir', async () => {
    await expect(loadGrokSkillRoots(input({ version: '1.0.44' }))).resolves.toMatchObject({
      pluginDirs: ['/app/plugin']
    })
    await expect(loadGrokSkillRoots(input({ version: '1.0.43' }))).resolves.toBeNull()
    await expect(loadGrokSkillRoots(input({ version: null }))).resolves.toBeNull()
  })

  it('leaves a folder of linked skills to the instructions, since its plugin folders skip links', async () => {
    const launch = await loadGrokSkillRoots(input({ version: '1.0.77' }))
    expect(launch?.loaded).toEqual([VISUALS])
    await expect(
      loadGrokSkillRoots(input({ roots: [LINKED], version: '1.0.77' }))
    ).resolves.toBeNull()
  })
})

describe('OpenCode skill roots', () => {
  it('adds every root as the only inline config when the user has none', async () => {
    await expect(loadOpenCodeSkillRoots(input({ version: '2.0.14' }))).resolves.toEqual({
      loaded: [VISUALS, LINKED],
      pluginDirs: [],
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          skills: { paths: ['/app/plugin/skills', '/repo/.agents/skills'] }
        })
      }
    })
  })

  it("keeps the user's own inline config and skill paths", () => {
    const merged = withOpenCodeSkillsPaths(
      JSON.stringify({ model: 'm', skills: { paths: ['/mine'], urls: ['https://x'] } }),
      ['/a', '/b']
    )
    expect(JSON.parse(merged!)).toEqual({
      model: 'm',
      skills: { paths: ['/mine', '/a', '/b'], urls: ['https://x'] }
    })
    expect(
      JSON.parse(withOpenCodeSkillsPaths(JSON.stringify({ skills: ['/mine'] }), ['/a'])!)
    ).toEqual({ skills: ['/mine', '/a'] })
  })

  it('leaves a config it cannot extend safely alone', async () => {
    for (const content of ['{ // jsonc\n}', '[]', '{"skills": 3}', '{"skills": {"paths": "/x"}}']) {
      expect(withOpenCodeSkillsPaths(content, ['/a'])).toBeNull()
    }
    await expect(
      loadOpenCodeSkillRoots(
        input({ version: '2.0.14', env: { OPENCODE_CONFIG_CONTENT: 'not json' } })
      )
    ).resolves.toBeNull()
  })

  it("skips 1.x, where the inline list would replace the user's own skill paths", async () => {
    await expect(loadOpenCodeSkillRoots(input({ version: '1.18.31' }))).resolves.toBeNull()
    await expect(loadOpenCodeSkillRoots(input({ version: null }))).resolves.toBeNull()
  })
})

describe('OMP skill roots', () => {
  it("passes every plugin folder, linked skills too, and leaves the user's config files alone", async () => {
    await expect(
      loadOmpSkillRoots(input({ version: '17.2.9', env: { PI_CONFIG_FILES: '/user/overlay.yml' } }))
    ).resolves.toEqual({ loaded: [VISUALS, LINKED], pluginDirs: ['/app/plugin', '/repo/.agents'] })
  })
  it('loads none on 18.1.5–18.1.8, which skip plugin-folder skills, so they are listed instead', async () => {
    for (const version of ['18.1.5', '18.1.8']) {
      await expect(loadOmpSkillRoots(input({ version }))).resolves.toBeNull()
    }
    await expect(loadOmpSkillRoots(input({ version: '18.1.9' }))).resolves.toMatchObject({
      loaded: [VISUALS, LINKED]
    })
  })
})
