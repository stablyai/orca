import { describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { PLUGIN_MANIFEST_V2_SINCE } from '../../shared/plugins/plugin-schema-field-docs'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { enableIfDataPlugin } from './plugin-one-click-enable'

function installed(execution: 'data' | 'instructional', contributes: Record<string, unknown>) {
  const plugin: ValidDiscoveredPlugin = {
    pluginKey: 'acme.demo',
    rootDir: '/plugins/acme.demo/hash',
    manifest: pluginManifestSchema.parse({
      manifestVersion: 2,
      execution,
      id: 'demo',
      publisher: 'acme',
      name: 'Demo',
      version: '1.0.0',
      engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
      contributes
    }),
    consentFingerprint: 'sha256-installed',
    contentHash: 'a'.repeat(64),
    isDev: false
  }
  return plugin
}

const theme = { themes: [{ id: 'dusk', label: 'Dusk', path: 'dusk.json' }] }
const command = { commands: [{ id: 'tasks', title: 'Tasks', action: 'view.tasks' }] }

describe('enableIfDataPlugin', () => {
  it('approves a content-only plugin with the installed fingerprint', async () => {
    const approve = vi.fn(async () => undefined)
    await expect(
      enableIfDataPlugin({
        pluginKey: 'acme.demo',
        installedFingerprint: 'sha256-installed',
        findValidPlugin: () => installed('data', theme),
        approve
      })
    ).resolves.toEqual({ needsReview: false })
    expect(approve).toHaveBeenCalledWith('acme.demo', 'sha256-installed')
  })

  it.each([
    ['a plugin that adds instructions', installed('instructional', command), 'sha256-installed'],
    ['bytes other than the ones just installed', installed('data', theme), 'sha256-other'],
    ['a plugin that failed discovery', null, 'sha256-installed'],
    ['a development override', { ...installed('data', theme), isDev: true }, 'sha256-installed']
  ])('leaves %s for review', async (_label, plugin, installedFingerprint) => {
    const approve = vi.fn(async () => undefined)
    await expect(
      enableIfDataPlugin({
        pluginKey: 'acme.demo',
        installedFingerprint,
        findValidPlugin: () => plugin,
        approve
      })
    ).resolves.toEqual({ needsReview: true })
    expect(approve).not.toHaveBeenCalled()
  })

  it('approves only the fingerprint the user saw at preview', async () => {
    const approve = vi.fn(async () => undefined)
    const run = (expectedFingerprint: string) =>
      enableIfDataPlugin({
        pluginKey: 'acme.demo',
        installedFingerprint: 'sha256-installed',
        expectedFingerprint,
        findValidPlugin: () => installed('data', theme),
        approve
      })
    await expect(run('sha256-installed')).resolves.toEqual({ needsReview: false })
    expect(approve).toHaveBeenCalledOnce()
    approve.mockClear()
    await expect(run('sha256-previewed-earlier')).resolves.toEqual({ needsReview: true })
    expect(approve).not.toHaveBeenCalled()
  })
})
