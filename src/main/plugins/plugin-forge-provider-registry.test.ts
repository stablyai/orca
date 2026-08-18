import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PluginManifest } from '../../shared/plugins/plugin-manifest'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import type { DiscoveredPlugin, ValidDiscoveredPlugin } from './plugin-discovery'
import { PluginForgeProviderRegistry } from './plugin-forge-provider-registry'

function pluginWith(
  pluginKey: string,
  contributes: { forgeProviders: PluginManifest['contributes']['forgeProviders'] },
  rootDir: string
): ValidDiscoveredPlugin {
  return {
    pluginKey,
    rootDir,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 1,
      id: pluginKey.split('.')[1] ?? pluginKey,
      publisher: pluginKey.split('.')[0] ?? 'test',
      name: pluginKey,
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes,
      capabilities: []
    }),
    consentFingerprint: 'sha256-test',
    contentHash: null,
    isDev: true
  }
}

const VALID_MODULE = `
export async function resolveRepository() { return { owner: 'acme', repo: 'app' } }
export async function getReviewForBranch() { return null }
export async function getReviewByNumber() { return null }
`

function pluginDirWithModule(moduleSource: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-provider-test-'))
  writeFileSync(join(dir, 'provider.mjs'), moduleSource)
  return dir
}

describe('PluginForgeProviderRegistry', () => {
  it('loads approved plugin providers and exposes them for host lookup', async () => {
    const registry = new PluginForgeProviderRegistry()
    const dir = pluginDirWithModule(VALID_MODULE)
    const plugin = pluginWith(
      'acme.corpforge',
      {
        forgeProviders: [
          {
            id: 'corpforge',
            displayName: 'Corp Forge',
            hosts: ['git.corp.example'],
            modulePath: 'provider.mjs',
            supportsReviewCreation: true
          }
        ]
      },
      dir
    )

    await registry.reconcile([plugin], () => true)

    expect(registry.list()).toHaveLength(1)
    const entry = registry.findByHost('GIT.CORP.EXAMPLE')
    expect(entry?.id).toBe('corpforge')
    expect(entry?.provider.supportsReviewCreation).toBe(true)
    expect(registry.getByProviderId('corpforge')?.id).toBe('corpforge')
    expect(registry.error(plugin.pluginKey)).toBeNull()
  })

  it('rejects modules missing required exports with a load error', async () => {
    const registry = new PluginForgeProviderRegistry()
    const dir = pluginDirWithModule('export const resolveRepository = () => null\n')
    const plugin = pluginWith(
      'acme.broken',
      {
        forgeProviders: [
          {
            id: 'broken',
            displayName: 'Broken',
            hosts: ['git.example'],
            modulePath: 'provider.mjs',
            supportsReviewCreation: true
          }
        ]
      },
      dir
    )

    await registry.reconcile([plugin], () => true)

    expect(registry.list()).toHaveLength(0)
    expect(registry.error(plugin.pluginKey)).toContain('failed to load forge provider')
  })

  it('flags duplicate contribution ids across plugins', async () => {
    const registry = new PluginForgeProviderRegistry()
    const dirA = pluginDirWithModule(VALID_MODULE)
    const dirB = pluginDirWithModule(VALID_MODULE)
    const pluginA = pluginWith(
      'acme.one',
      {
        forgeProviders: [
          {
            id: 'shared',
            displayName: 'A',
            hosts: ['a.example'],
            modulePath: 'provider.mjs',
            supportsReviewCreation: true
          }
        ]
      },
      dirA
    )
    const pluginB = pluginWith(
      'acme.two',
      {
        forgeProviders: [
          {
            id: 'shared',
            displayName: 'B',
            hosts: ['b.example'],
            modulePath: 'provider.mjs',
            supportsReviewCreation: true
          }
        ]
      },
      dirB
    )

    await registry.reconcile([pluginA, pluginB], () => true)

    expect(registry.list()).toHaveLength(1)
    expect(registry.error(pluginB.pluginKey)).toContain('already claimed')
    expect(registry.getByProviderId('shared')?.supportsReviewCreation).toBe(true)
  })

  it('keeps previews for unapproved plugins without loading them', async () => {
    const registry = new PluginForgeProviderRegistry()
    const dir = pluginDirWithModule(VALID_MODULE)
    const plugin = pluginWith(
      'acme.pending',
      {
        forgeProviders: [
          {
            id: 'pending',
            displayName: 'Pending',
            hosts: ['git.example'],
            modulePath: 'provider.mjs',
            supportsReviewCreation: true
          }
        ]
      },
      dir
    )

    await registry.reconcile([plugin], () => false)

    expect(registry.list()).toHaveLength(0)
    expect(registry.preview()).toHaveLength(1)
    expect(registry.preview()[0]?.id).toBe('pending')
  })

  it('drops entries for a removed plugin', async () => {
    const registry = new PluginForgeProviderRegistry()
    const dir = pluginDirWithModule(VALID_MODULE)
    const plugin = pluginWith(
      'acme.gone',
      {
        forgeProviders: [
          {
            id: 'gone',
            displayName: 'Gone',
            hosts: ['git.example'],
            modulePath: 'provider.mjs',
            supportsReviewCreation: true
          }
        ]
      },
      dir
    )

    await registry.reconcile([plugin], () => true)
    expect(registry.list()).toHaveLength(1)

    registry.clearPlugin(plugin.pluginKey)
    expect(registry.list()).toHaveLength(0)
    expect(registry.findByHost('git.example')).toBeNull()
  })

  it('ignores plugins without forge provider contributions', async () => {
    const registry = new PluginForgeProviderRegistry()
    const plugin = pluginWith('acme.plain', { forgeProviders: [] }, join(tmpdir(), 'nowhere'))

    await registry.reconcile([plugin], () => true)

    expect(registry.list()).toHaveLength(0)
    expect(registry.preview()).toHaveLength(0)
  })

  it('survives invalid discovered plugins in the candidate list', async () => {
    const registry = new PluginForgeProviderRegistry()
    const dir = pluginDirWithModule(VALID_MODULE)
    const valid = pluginWith(
      'acme.ok',
      {
        forgeProviders: [
          {
            id: 'ok',
            displayName: 'OK',
            hosts: ['git.example'],
            modulePath: 'provider.mjs',
            supportsReviewCreation: true
          }
        ]
      },
      dir
    )
    const invalid: DiscoveredPlugin = {
      rootDir: join(tmpdir(), 'nope'),
      error: 'missing orca-plugin.json',
      isDev: false
    }

    await registry.reconcile([invalid, valid], () => true)

    expect(registry.list()).toHaveLength(1)
    expect(registry.findByHost('git.example')?.id).toBe('ok')
  })

  it('preserves the plugin-provided copy when the module exports one', async () => {
    const registry = new PluginForgeProviderRegistry()
    const dir = pluginDirWithModule(
      `${VALID_MODULE}export const copy = { shortLabel: 'PR', reviewLabel: 'Review', titleLabel: 'Pull request', providerName: 'Corp', authInstruction: 'Set a token' }\n`
    )
    const plugin = pluginWith(
      'acme.copy',
      {
        forgeProviders: [
          {
            id: 'copyforge',
            displayName: 'Copy',
            hosts: ['git.example'],
            modulePath: 'provider.mjs',
            supportsReviewCreation: true
          }
        ]
      },
      dir
    )

    await registry.reconcile([plugin], () => true)

    expect(registry.getByProviderId('copyforge')?.copy?.providerName).toBe('Corp')
  })

  it('loads action exports (mergeReview, commentReview, listIssues) when the module provides them', async () => {
    const registry = new PluginForgeProviderRegistry()
    const dir = pluginDirWithModule(
      `${VALID_MODULE}\nexport async function mergeReview() { return { ok: true } }\nexport async function commentReview() { return { ok: true } }\nexport async function listIssues() { return { ok: true, issues: [] } }\n`
    )
    const plugin = pluginWith(
      'acme.actions',
      {
        forgeProviders: [
          {
            id: 'actionsforge',
            displayName: 'Actions',
            hosts: ['git.example'],
            modulePath: 'provider.mjs',
            supportsReviewCreation: true
          }
        ]
      },
      dir
    )

    await registry.reconcile([plugin], () => true)

    const provider = registry.getByProviderId('actionsforge')
    expect(typeof provider?.mergeReview).toBe('function')
    expect(typeof provider?.commentReview).toBe('function')
    expect(typeof provider?.listIssues).toBe('function')
  })
})
