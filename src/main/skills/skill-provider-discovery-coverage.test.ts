import { join, posix, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SKILL_INSTALL_PROVIDERS } from '../../shared/skill-install-providers'
import { buildSkillDiscoverySources } from './skill-discovery-sources'
import { resolveEnvironmentSkillProviderRoots } from './skill-provider-runtime-roots'

const HOME = '/home/test'
const WORKSPACE = '/workspace/current'

function discover(providerRootOverrides = {}) {
  return buildSkillDiscoverySources({
    homeDir: HOME,
    cwd: WORKSPACE,
    pathApi: posix,
    providerRootOverrides
  })
}

describe('skill install provider table drives discovery', () => {
  it('lists every provider install folder at each scope it has one', () => {
    const sources = discover()
    for (const provider of SKILL_INSTALL_PROVIDERS) {
      if (provider.globalSegments) {
        expect(sources, provider.id).toContainEqual(
          expect.objectContaining({
            path: posix.join(HOME, ...provider.globalSegments),
            label: `${provider.displayName} home`,
            sourceKind: 'home',
            owner: provider.id
          })
        )
      }
      if (provider.workspaceSegments) {
        expect(sources, provider.id).toContainEqual(
          expect.objectContaining({
            path: posix.join(WORKSPACE, ...provider.workspaceSegments),
            sourceKind: 'repo',
            owner: provider.id
          })
        )
      }
    }
    // Agents with a null scope read the canonical root, which is always listed.
    expect(sources.map((source) => source.path)).toEqual(
      expect.arrayContaining([
        posix.join(HOME, '.agents', 'skills'),
        posix.join(WORKSPACE, '.agents', 'skills')
      ])
    )
  })

  it('relocates a provider home named by its env var for install and discovery alike', () => {
    for (const provider of SKILL_INSTALL_PROVIDERS) {
      if (!provider.homeEnv) {
        continue
      }
      const relocated = resolve('/srv', provider.id)
      const overrides = resolveEnvironmentSkillProviderRoots(
        { [provider.homeEnv]: relocated },
        resolve(HOME)
      )
      expect(overrides).toEqual({ [provider.id]: join(relocated, 'skills') })
      expect(
        discover(overrides).find(
          (source) => source.sourceKind === 'home' && source.owner === provider.id
        )?.path
      ).toBe(overrides[provider.id])
    }
  })

  it('names each provider home with a plain env var the WSL probe can expand', () => {
    for (const provider of SKILL_INSTALL_PROVIDERS) {
      if (provider.homeEnv) {
        expect(provider.homeEnv).toMatch(/^[A-Z_][A-Z0-9_]*$/u)
      }
    }
  })
})
