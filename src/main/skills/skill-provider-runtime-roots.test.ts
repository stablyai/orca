import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  resolveEnvironmentSkillProviderRoots,
  resolveWslGrokSkillProviderRoot,
  withClaudeSkillProviderRoot
} from './skill-provider-runtime-roots'


// Why a volume: production resolve()s its input, so a drive-less `/srv` came
// back as `C:srv` on Windows while the expectation kept the bare form. The
// roots are synthetic; they only have to be absolute the way this host is.
const VOLUME = process.platform === 'win32' ? 'C:\\' : '/'

describe('skill provider runtime roots', () => {
  it('maps Claude and Grok config homes to their global skill roots', () => {
    expect(
      resolveEnvironmentSkillProviderRoots({
        CLAUDE_CONFIG_DIR: join(VOLUME, 'srv', 'claude'),
        GROK_HOME: join(VOLUME, 'srv', 'grok')
      })
    ).toEqual({
      claude: join(VOLUME, 'srv', 'claude', 'skills'),
      grok: join(VOLUME, 'srv', 'grok', 'skills')
    })
  })

  it('rejects relative config roots and lets a target-specific Claude root win', () => {
    const roots = resolveEnvironmentSkillProviderRoots({
      CLAUDE_CONFIG_DIR: '../claude',
      GROK_HOME: '../grok'
    })
    expect(roots).toEqual({})
    expect(withClaudeSkillProviderRoot(roots, join(VOLUME, 'managed', 'claude'))).toEqual({
      claude: join(VOLUME, 'managed', 'claude', 'skills')
    })
  })

  it('maps the WSL login shell GROK_HOME to a host-readable skill root', async () => {
    await expect(
      resolveWslGrokSkillProviderRoot('Ubuntu-24.04', async () => '/srv/grok\n')
    ).resolves.toBe('\\\\wsl.localhost\\Ubuntu-24.04\\srv\\grok\\skills')
  })

  it('ignores unsafe or missing WSL GROK_HOME values', async () => {
    await expect(
      resolveWslGrokSkillProviderRoot('Ubuntu', async () => '../grok')
    ).resolves.toBeNull()
    await expect(
      resolveWslGrokSkillProviderRoot('Ubuntu', async () => '/srv/grok\0other')
    ).resolves.toBeNull()
    await expect(
      resolveWslGrokSkillProviderRoot('Ubuntu', async () => {
        throw new Error('probe failed')
      })
    ).resolves.toBeNull()
  })
})
