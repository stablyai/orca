import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { resolveEnvironmentSkillProviderRoots } from './skill-provider-runtime-roots'

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
})
