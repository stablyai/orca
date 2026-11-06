import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SKILL_INSTALL_PROVIDERS } from '../../shared/skill-install-providers'
import {
  resolveEnvironmentSkillProviderRoots,
  resolveWslSkillProviderRoots
} from './skill-provider-runtime-roots'

// Probe order is guest HOME, then table homeEnv values, all NUL-terminated.
function wslHomes(values: Record<string, string>, home = '/home/dev'): string {
  return [
    home,
    ...SKILL_INSTALL_PROVIDERS.flatMap((provider) =>
      provider.homeEnv ? [values[provider.homeEnv] ?? ''] : []
    )
  ]
    .map((value) => `${value}\0`)
    .join('')
}

describe('skill provider runtime roots', () => {
  it('falls back to the default folder for a home at the root, the user home or above it', () => {
    const userHome = resolve('/home/dev')
    for (const unusable of [resolve('/'), resolve('/home'), userHome]) {
      expect(
        resolveEnvironmentSkillProviderRoots(
          { GROK_HOME: unusable, KIRO_HOME: unusable },
          userHome
        ),
        unusable
      ).toEqual({})
    }
    const inside = join(userHome, 'profiles', 'kiro')
    expect(resolveEnvironmentSkillProviderRoots({ KIRO_HOME: inside }, userHome)).toEqual({
      kiro: join(inside, 'skills')
    })
  })

  it('ignores unsafe, unusable, incomplete or missing WSL home values', async () => {
    for (const value of ['../grok', '/srv/a\tb', '/', '/home', '/home/dev', '/home/dev/']) {
      await expect(
        resolveWslSkillProviderRoots('Ubuntu', async () => wslHomes({ GROK_HOME: value })),
        value
      ).resolves.toEqual({})
    }
    await expect(
      resolveWslSkillProviderRoots('Ubuntu', async () =>
        wslHomes({ GROK_HOME: '/home/dev/profiles/grok' })
      )
    ).resolves.toEqual({
      grok: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\profiles\\grok\\skills'
    })
    // Missing final NUL means incomplete output; trust none of it.
    await expect(
      resolveWslSkillProviderRoots('Ubuntu', async () =>
        wslHomes({ GROK_HOME: '/srv/grok' }).slice(0, -1)
      )
    ).resolves.toEqual({})
    // Without an absolute guest HOME the safety guard cannot run; trust no overrides.
    for (const home of ['', 'home/dev']) {
      await expect(
        resolveWslSkillProviderRoots('Ubuntu', async () =>
          wslHomes({ GROK_HOME: '/srv/grok' }, home)
        ),
        home
      ).resolves.toEqual({})
    }
    await expect(resolveWslSkillProviderRoots('Ubuntu', async () => null)).resolves.toEqual({})
    await expect(
      resolveWslSkillProviderRoots('Ubuntu', async () => {
        throw new Error('probe failed')
      })
    ).resolves.toEqual({})
  })
})
