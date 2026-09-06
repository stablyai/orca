import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  resolveDefaultHermesSkillsRoot,
  resolveEnvironmentHermesSkillsRoot,
  resolveEnvironmentSkillProviderRoots,
  resolveWslGrokSkillProviderRoot,
  withClaudeSkillProviderRoot
} from './skill-provider-runtime-roots'

describe('skill provider runtime roots', () => {
  it('maps Claude and Grok config homes to their global skill roots', () => {
    const claudeRoot = resolve('/srv/claude')
    const grokRoot = resolve('/srv/grok')
    expect(
      resolveEnvironmentSkillProviderRoots({
        CLAUDE_CONFIG_DIR: claudeRoot,
        GROK_HOME: grokRoot
      })
    ).toEqual({
      claude: join(claudeRoot, 'skills'),
      grok: join(grokRoot, 'skills')
    })
  })

  it('rejects relative config roots and lets a target-specific Claude root win', () => {
    const roots = resolveEnvironmentSkillProviderRoots({
      CLAUDE_CONFIG_DIR: '../claude',
      GROK_HOME: '../grok'
    })
    expect(roots).toEqual({})
    const managedClaudeRoot = resolve('/managed/claude')
    expect(withClaudeSkillProviderRoot(roots, managedClaudeRoot)).toEqual({
      claude: join(managedClaudeRoot, 'skills')
    })
  })

  it('maps a relocated HERMES_HOME to its skill root and ignores relative ones', () => {
    const hermesRoot = resolve('/srv/hermes')
    expect(resolveEnvironmentHermesSkillsRoot({ HERMES_HOME: hermesRoot })).toBe(
      join(hermesRoot, 'skills')
    )
    expect(resolveEnvironmentHermesSkillsRoot({ HERMES_HOME: '../hermes' })).toBeNull()
    expect(resolveEnvironmentHermesSkillsRoot({})).toBeNull()
  })

  it('defaults the Hermes skills root to the home dotfolder off Windows', () => {
    expect(
      resolveDefaultHermesSkillsRoot({
        homeDir: join('/users', 'alice'),
        platform: 'linux',
        env: { LOCALAPPDATA: join('/local') },
        directoryExists: () => true
      })
    ).toBe(join('/users', 'alice', '.hermes', 'skills'))
  })

  it('defaults the Hermes skills root under LOCALAPPDATA on Windows', () => {
    const localAppData = resolve('/local')
    const resolved = resolveDefaultHermesSkillsRoot({
      homeDir: join('/users', 'alice'),
      platform: 'win32',
      env: { LOCALAPPDATA: localAppData },
      directoryExists: (candidate) => candidate === join(localAppData, 'hermes')
    })
    expect(resolved).toBe(join(localAppData, 'hermes', 'skills'))
  })

  it('keeps a pre-LOCALAPPDATA Windows dotfolder install discoverable', () => {
    const resolved = resolveDefaultHermesSkillsRoot({
      homeDir: join('/users', 'alice'),
      platform: 'win32',
      env: { LOCALAPPDATA: join('/local') },
      directoryExists: (candidate) => candidate === join('/users', 'alice', '.hermes')
    })
    expect(resolved).toBe(join('/users', 'alice', '.hermes', 'skills'))
  })

  it('prefers the LOCALAPPDATA tree on Windows when both layouts exist', () => {
    const localAppData = resolve('/local')
    const resolved = resolveDefaultHermesSkillsRoot({
      homeDir: join('/users', 'alice'),
      platform: 'win32',
      env: { LOCALAPPDATA: localAppData },
      directoryExists: () => true
    })
    expect(resolved).toBe(join(localAppData, 'hermes', 'skills'))
  })

  it('falls back to the dotfolder when Windows exposes no usable LOCALAPPDATA', () => {
    const seen: string[] = []
    const resolved = resolveDefaultHermesSkillsRoot({
      homeDir: join('/users', 'alice'),
      platform: 'win32',
      env: { LOCALAPPDATA: 'relative\\local' },
      directoryExists: (candidate) => {
        seen.push(candidate)
        return true
      }
    })
    expect(resolved).toBe(join('/users', 'alice', '.hermes', 'skills'))
    // A rejected LOCALAPPDATA must not cost a stat: there is nothing to compare.
    expect(seen).toEqual([])
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
