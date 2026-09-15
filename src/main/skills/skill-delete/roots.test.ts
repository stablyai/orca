import { describe, expect, it, vi } from 'vitest'

vi.mock('../claude-plugin-skill-sources-wsl', () => ({
  discoverClaudePluginSkillSourcesInWsl: vi.fn().mockResolvedValue([])
}))

import { discoverClaudePluginSkillSourcesInWsl } from '../claude-plugin-skill-sources-wsl'
import { buildSkillDeleteRootSet } from './roots'

describe('WSL skill deletion root ownership', () => {
  it('uses the guest home for an omitted cwd, preserving the prior resolved target', async () => {
    const target = {
      kind: 'wsl' as const,
      distro: 'Ubuntu',
      homeDir: '/home/alice',
      cwd: undefined
    }

    const omitted = await buildSkillDeleteRootSet({ target, repos: [] })

    const explicit = await buildSkillDeleteRootSet({
      target: { ...target, cwd: target.homeDir },
      repos: []
    })

    expect(omitted.roots).toEqual(explicit.roots)
    expect(omitted.roots.every((root) => root.path.startsWith('/home/alice/'))).toBe(true)
    expect(discoverClaudePluginSkillSourcesInWsl).toHaveBeenCalledWith({
      distro: 'Ubuntu',
      homeDir: '/home/alice',
      cwd: '/home/alice'
    })
  })
})
