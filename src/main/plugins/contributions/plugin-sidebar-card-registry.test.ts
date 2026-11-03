import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintPluginConsent } from '../../../shared/plugins/approval/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import { PluginContentVerifier } from '../plugin-content-integrity'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import { createPluginSidebarCardRegistry } from './plugin-sidebar-card-registry'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function cardPlugin(template: unknown): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-card-registry-'))
  roots.push(rootDir)
  await writeFile(join(rootDir, 'card.json'), JSON.stringify(template))
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 2,
    id: 'focus',
    name: 'Focus',
    version: '1.0.0',
    execution: 'data',
    engines: { orca: '>=1.4.248' },
    contributes: { sidebarCards: [{ id: 'focus', title: 'Focus', template: 'card.json' }] }
  })
  return {
    pluginKey: 'samples.focus',
    rootDir,
    manifest,
    consentFingerprint: fingerprintPluginConsent(manifest),
    contentHash: null,
    isDev: true
  }
}

const valid = {
  version: 1,
  facts: 1,
  root: { el: 'Row', children: [{ el: 'Title' }, { el: 'Text', props: { text: '=ws.branch' } }] }
}

describe('plugin sidebar card registry', () => {
  it('loads a card template under a host-owned id', async () => {
    const registry = createPluginSidebarCardRegistry(new PluginContentVerifier())
    await registry.reconcile([await cardPlugin(valid)], () => true)
    expect(registry.list()).toEqual([
      expect.objectContaining({
        id: 'plugin:samples.focus/focus',
        pluginKey: 'samples.focus',
        label: 'Focus',
        template: expect.objectContaining({ root: valid.root })
      })
    ])
    expect(registry.error('samples.focus')).toBeNull()
  })

  it('refuses a template the renderer could not draw, and says why', async () => {
    const registry = createPluginSidebarCardRegistry(new PluginContentVerifier())
    const plugin = await cardPlugin({ ...valid, root: { el: 'Script', props: { src: 'x' } } })
    await registry.reconcile([plugin], () => true)
    expect(registry.list()).toEqual([])
    expect(registry.error('samples.focus')).toMatch(/unknown element Script/)
  })
})
