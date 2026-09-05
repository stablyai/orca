import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  resolveEnvironmentSkillProviderRoots,
  resolveEnvironmentZeroClawSkillsRoot
} from './skill-provider-runtime-roots'
import { resolveSkillProviderDestinations } from './skill-provider-destinations'

describe('ZeroClaw skill provider roots', () => {
  it('resolves default global destination when ZEROCLAW_HOME is unset', () => {
    const destinations = resolveSkillProviderDestinations({
      scope: 'global',
      homeDirectory: '/Users/testuser',
      detectedProviders: ['zeroclaw']
    })

    expect(destinations).toEqual([
      {
        provider: 'zeroclaw',
        readsCanonicalRoot: false,
        rootPath: join('/Users/testuser', '.zeroclaw', 'skills')
      }
    ])
  })

  it('resolves workspace destination for ZeroClaw', () => {
    const destinations = resolveSkillProviderDestinations({
      scope: 'workspace',
      homeDirectory: '/Users/testuser',
      workspaceDirectory: '/Users/testuser/project',
      detectedProviders: ['zeroclaw']
    })

    expect(destinations).toEqual([
      {
        provider: 'zeroclaw',
        readsCanonicalRoot: false,
        rootPath: join('/Users/testuser/project', '.zeroclaw', 'skills')
      }
    ])
  })

  it('honours ZEROCLAW_HOME environment override', () => {
    const env = { ZEROCLAW_HOME: '/custom/zeroclaw/root' }
    const overrides = resolveEnvironmentSkillProviderRoots(env)
    expect(overrides).toEqual({
      zeroclaw: '/custom/zeroclaw/root/skills'
    })
    expect(resolveEnvironmentZeroClawSkillsRoot(env)).toBe('/custom/zeroclaw/root/skills')

    const destinations = resolveSkillProviderDestinations({
      scope: 'global',
      homeDirectory: '/Users/testuser',
      detectedProviders: ['zeroclaw'],
      providerRootOverrides: overrides
    })

    expect(destinations).toEqual([
      {
        provider: 'zeroclaw',
        readsCanonicalRoot: false,
        rootPath: '/custom/zeroclaw/root/skills'
      }
    ])
  })

  it('honours ZEROCLAW_STATE_DIR over ZEROCLAW_HOME', () => {
    const env = {
      ZEROCLAW_STATE_DIR: '/state/zeroclaw',
      ZEROCLAW_HOME: '/home/zeroclaw'
    }
    const overrides = resolveEnvironmentSkillProviderRoots(env)
    expect(overrides.zeroclaw).toBe('/state/zeroclaw/skills')
  })
})
