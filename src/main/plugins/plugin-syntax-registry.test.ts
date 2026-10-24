import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { PluginContentVerifier } from './plugin-content-integrity'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { PluginSyntaxRegistry } from './plugin-syntax-registry'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function syntaxPlugin(files: Record<string, unknown>): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-syntax-'))
  roots.push(rootDir)
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(rootDir, name), JSON.stringify(content))
  }
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'demo-syntax',
    publisher: 'samples',
    name: 'Demo syntax',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: {
      syntaxes: [
        {
          id: 'demo',
          label: 'Demo',
          scopeName: 'source.demo',
          path: 'demo.json',
          configuration: 'demo-config.json',
          extensions: ['.Demo'],
          filenames: ['Demofile']
        },
        { id: 'embedded', label: 'Embedded', scopeName: 'source.embedded', path: 'embedded.json' }
      ]
    }
  })
  return {
    pluginKey: 'samples.demo-syntax',
    rootDir,
    manifest,
    consentFingerprint: fingerprintPluginConsent(manifest),
    contentHash: null,
    isDev: true
  }
}

const demo = {
  scopeName: 'source.demo',
  patterns: [{ include: 'source.embedded' }, { match: '//.*', name: 'comment.line' }]
}
const embedded = { scopeName: 'source.embedded', patterns: [{ match: '\\d+' }] }

it('lists file associations and hands over a language with its sibling grammars', async () => {
  const registry = new PluginSyntaxRegistry(new PluginContentVerifier())
  await registry.reconcile(
    [
      await syntaxPlugin({
        'demo.json': demo,
        'demo-config.json': { comments: { lineComment: '//' } },
        'embedded.json': embedded
      })
    ],
    () => true
  )

  expect(registry.list()).toEqual([
    expect.objectContaining({
      id: 'plugin:samples.demo-syntax/demo',
      label: 'Demo',
      extensions: ['.demo'],
      filenames: ['demofile'],
      revision: expect.stringMatching(/^[0-9a-f]{32}$/)
    }),
    expect.objectContaining({ id: 'plugin:samples.demo-syntax/embedded', extensions: [] })
  ])
  expect(registry.load('plugin:samples.demo-syntax/demo')).toMatchObject({
    scopeName: 'source.demo',
    grammars: [{ scopeName: 'source.demo' }, { scopeName: 'source.embedded' }],
    configuration: { comments: { lineComment: '//' } }
  })
  expect(registry.load('plugin:samples.demo-syntax/missing')).toBeNull()
})

it('reports one error and lists nothing when a grammar is invalid', async () => {
  const registry = new PluginSyntaxRegistry(new PluginContentVerifier())
  const plugin = await syntaxPlugin({
    'demo.json': { ...demo, scopeName: 'source.other' },
    'demo-config.json': {},
    'embedded.json': embedded
  })
  await registry.reconcile([plugin], () => true)

  expect(registry.list()).toEqual([])
  expect(registry.error(plugin.pluginKey)).toContain('syntax "demo"')
})

it('reports an include that does not resolve inside the plugin on the plugin card', async () => {
  const registry = new PluginSyntaxRegistry(new PluginContentVerifier())
  const plugin = await syntaxPlugin({
    'demo.json': { ...demo, patterns: [{ include: 'source.embedded#missing' }] },
    'demo-config.json': {},
    'embedded.json': embedded
  })
  await registry.reconcile([plugin], () => true)

  expect(registry.list()).toEqual([])
  expect(registry.load('plugin:samples.demo-syntax/demo')).toBeNull()
  expect(registry.error(plugin.pluginKey)).toContain('does not resolve')
})
