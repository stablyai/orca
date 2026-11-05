import { describe, expect, it } from 'vitest'
import {
  loadGrokVisualsSkill,
  loadOmpVisualsSkill,
  loadOpenCodeVisualsSkill,
  withOpenCodeSkillsPath,
  type AcpVisualsSkillInput
} from './acp-visuals-skill'

const SKILL = { pluginDir: '/app/plugin', skillsRoot: '/app/plugin/skills' }

function input(overrides: Partial<AcpVisualsSkillInput> = {}): AcpVisualsSkillInput {
  return {
    skill: SKILL,
    version: null,
    env: {},
    ...overrides
  }
}

describe('Grok visuals skill', () => {
  it('names the plugin folder only on a release known to take --plugin-dir', async () => {
    await expect(loadGrokVisualsSkill(input({ version: '1.0.46' }))).resolves.toEqual({
      pluginDir: '/app/plugin'
    })
    await expect(loadGrokVisualsSkill(input({ version: '1.0.44' }))).resolves.toEqual({
      pluginDir: '/app/plugin'
    })
    await expect(loadGrokVisualsSkill(input({ version: '1.0.43' }))).resolves.toBeNull()
    await expect(loadGrokVisualsSkill(input({ version: null }))).resolves.toBeNull()
  })
})

describe('OpenCode visuals skill', () => {
  it('adds the skills root as the only inline config when the user has none', async () => {
    await expect(loadOpenCodeVisualsSkill(input({ version: '2.0.14' }))).resolves.toEqual({
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ skills: { paths: [SKILL.skillsRoot] } }) }
    })
  })

  it("keeps the user's own inline config and skill paths", () => {
    const merged = withOpenCodeSkillsPath(
      JSON.stringify({ model: 'm', skills: { paths: ['/mine'], urls: ['https://x'] } }),
      SKILL.skillsRoot
    )
    expect(JSON.parse(merged!)).toEqual({
      model: 'm',
      skills: { paths: ['/mine', SKILL.skillsRoot], urls: ['https://x'] }
    })
    expect(
      JSON.parse(withOpenCodeSkillsPath(JSON.stringify({ skills: ['/mine'] }), SKILL.skillsRoot)!)
    ).toEqual({ skills: ['/mine', SKILL.skillsRoot] })
  })

  it('leaves a config it cannot extend safely alone', async () => {
    for (const content of ['{ // jsonc\n}', '[]', '{"skills": 3}', '{"skills": {"paths": "/x"}}']) {
      expect(withOpenCodeSkillsPath(content, SKILL.skillsRoot)).toBeNull()
    }
    await expect(
      loadOpenCodeVisualsSkill(
        input({ version: '2.0.14', env: { OPENCODE_CONFIG_CONTENT: 'not json' } })
      )
    ).resolves.toBeNull()
  })

  it("skips 1.x, where the inline list would replace the user's own skill paths", async () => {
    await expect(loadOpenCodeVisualsSkill(input({ version: '1.18.31' }))).resolves.toBeNull()
    await expect(loadOpenCodeVisualsSkill(input({ version: null }))).resolves.toBeNull()
  })
})

describe('OMP visuals skill', () => {
  it("names the plugin folder and leaves the user's own config files alone", async () => {
    await expect(
      loadOmpVisualsSkill(
        input({ version: '17.0.5', env: { PI_CONFIG_FILES: '/user/overlay.yml' } })
      )
    ).resolves.toEqual({ pluginDir: '/app/plugin' })
  })
})
