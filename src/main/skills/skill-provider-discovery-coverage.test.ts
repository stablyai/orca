import { join, posix, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SKILL_INSTALL_PROVIDERS } from '../../shared/skill-install-providers'
import type { TuiAgent } from '../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { buildSkillDiscoverySources } from './skill-discovery-sources'
import { resolveEnvironmentSkillProviderRoots } from './skill-provider-runtime-roots'

const HOME = '/home/test'

// New agents need a provider entry or an explicit unsupported reason.
const AGENTS_WITHOUT_INSTALL_PROVIDER: Partial<Record<TuiAgent, string>> = {
  'claude-agent-teams': 'detected only alongside claude, whose entry covers .claude/skills',
  aider: 'no skills support',
  hermes: 'Windows home under %LOCALAPPDATA% and opt-in project skills fit no table shape'
}
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

  it('gives every Orca agent an entry or a recorded reason it has none', () => {
    const covered = new Set<string>(SKILL_INSTALL_PROVIDERS.map((provider) => provider.id))
    for (const agent of Object.keys(TUI_AGENT_CONFIG)) {
      expect(
        covered.has(agent) !== Object.hasOwn(AGENTS_WITHOUT_INSTALL_PROVIDER, agent),
        agent
      ).toBe(true)
    }
  })

  it('keeps scanning Qoder folders it still reads after installs moved to the canonical root', () => {
    const qoderPaths = discover()
      .filter((source) => source.owner === 'qoder')
      .map((source) => source.path)
    expect(qoderPaths).toEqual(
      expect.arrayContaining([
        posix.join(HOME, '.qoder', 'skills'),
        posix.join(WORKSPACE, '.qoder', 'skills')
      ])
    )
  })
})
