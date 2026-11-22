import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveBundledSkillTargets } from '../bundled-skill-install/bundled-skill-targets'
import type { BundledSkillFilesystem } from '../bundled-skill-install/bundled-skill-filesystem'
import { buildSkillDiscoverySources } from '../discovery/skill-discovery-sources'
import { resolveSkillProviderDestinations } from './skill-provider-destinations'

const HOME = '/home/ada'

function missingFilesystem(): BundledSkillFilesystem {
  const unused = async (): Promise<never> => {
    throw new Error('unused')
  }
  return {
    supportsLinks: false,
    stat: async () => null,
    readLink: async () => null,
    realpath: async () => null,
    listEntries: async () => [],
    readFile: async () => null,
    canWrite: async () => false,
    writeFolder: unused,
    ensureDirectory: unused,
    rename: unused,
    moveToBackup: unused,
    remove: unused,
    createLink: unused
  }
}

describe('gemini skill placement', () => {
  it('installs Gemini global skills only in ~/.agents/skills and still discovers ~/.gemini/skills', async () => {
    const destinations = resolveSkillProviderDestinations({
      scope: 'global',
      homeDirectory: HOME,
      detectedProviders: ['gemini'],
      providerRootOverrides: { gemini: '/tmp/gemini-skills' }
    })
    expect(destinations).toEqual([
      {
        provider: 'gemini',
        readsCanonicalRoot: true,
        rootPath: join(HOME, '.agents', 'skills')
      }
    ])

    const targets = await resolveBundledSkillTargets(
      {
        destination: { scope: 'global', homeDirectory: HOME },
        agents: ['gemini']
      },
      missingFilesystem()
    )
    expect(targets.map((target) => ({ path: target.path, agents: target.agents }))).toEqual([
      { path: join(HOME, '.agents', 'skills'), agents: ['gemini'] }
    ])

    const sources = buildSkillDiscoverySources({
      homeDir: HOME,
      cwd: join(HOME, 'work'),
      pathApi: { basename, join }
    })
    expect(sources.find((source) => source.id === 'home-gemini')?.path).toBe(
      join(HOME, '.gemini', 'skills')
    )
  })

  it('keeps Claude on its own root and Antigravity on ~/.gemini/config/skills', async () => {
    const claude = resolveSkillProviderDestinations({
      scope: 'global',
      homeDirectory: HOME,
      detectedProviders: ['claude'],
      providerRootOverrides: { claude: '/tmp/claude-skills' }
    })
    expect(claude).toEqual([
      {
        provider: 'claude',
        readsCanonicalRoot: false,
        rootPath: '/tmp/claude-skills'
      }
    ])

    const antigravity = await resolveBundledSkillTargets(
      {
        destination: { scope: 'global', homeDirectory: HOME },
        agents: ['antigravity']
      },
      missingFilesystem()
    )
    expect(antigravity.map((target) => target.path)).toEqual([
      join(HOME, '.agents', 'skills'),
      join(HOME, '.gemini', 'config', 'skills')
    ])
  })
})
