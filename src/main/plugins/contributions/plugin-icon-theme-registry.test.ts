import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fingerprintPluginConsent } from '../../../shared/plugins/approval/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import { PluginContentVerifier } from '../plugin-content-integrity'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import { PluginIconThemeRegistry } from './plugin-icon-theme-registry'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function iconPlugin(svgs: Record<string, string>): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-icon-theme-'))
  roots.push(rootDir)
  await mkdir(join(rootDir, 'icons'))
  for (const [name, svg] of Object.entries(svgs)) {
    await writeFile(join(rootDir, 'icons', name), svg)
  }
  await writeFile(
    join(rootDir, 'theme.json'),
    JSON.stringify({
      schemaVersion: 1,
      icons: { folder: 'icons/folder.svg' },
      fileExtensions: { ts: 'icons/ts.svg' }
    })
  )
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'minimal-icons',
    publisher: 'samples',
    name: 'Minimal icons',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: { iconThemes: [{ id: 'minimal', title: 'Minimal', path: 'theme.json' }] }
  })
  return {
    pluginKey: 'samples.minimal-icons',
    rootDir,
    manifest,
    consentFingerprint: fingerprintPluginConsent(manifest),
    contentHash: null,
    isDev: true
  }
}

it('lists metadata and reads a theme only when it is loaded', async () => {
  const plugin = await iconPlugin({
    'folder.svg': '<svg viewBox="0 0 1 1"><path fill="currentColor" d="M0 0h1v1z"/></svg>',
    'ts.svg': '<svg viewBox="0 0 1 1"><rect width="1" height="1" fill="#3178c6"/></svg>'
  })
  const registry = new PluginIconThemeRegistry(new PluginContentVerifier())
  await registry.reconcile([plugin], () => true)

  expect(registry.list()).toEqual([
    {
      id: 'plugin:samples.minimal-icons/minimal',
      pluginKey: 'samples.minimal-icons',
      label: 'Minimal',
      revision: expect.stringMatching(/^[0-9a-f]{32}$/)
    }
  ])
  const theme = await registry.load('plugin:samples.minimal-icons/minimal')
  expect(theme?.svgs).toHaveLength(2)
  expect(theme?.svgs[theme.icons.folder ?? -1]).toContain('currentColor')
  expect(theme?.svgs[theme.fileExtensions.ts ?? -1]).toContain('#3178c6')
  await expect(registry.load('plugin:samples.other/x')).resolves.toBeNull()

  // An update that changes only SVG bytes keeps id and title but installs a new tree hash.
  const revision = registry.list()[0]?.revision
  await registry.reconcile([{ ...plugin, contentHash: 'a'.repeat(64) }], () => true)
  expect(registry.list()[0]?.revision).not.toBe(revision)
})

it('fails a load whose file is not an SVG document and forgets themes once disabled', async () => {
  const plugin = await iconPlugin({
    'folder.svg': '<!DOCTYPE svg [<!ENTITY x "y">]><svg/>',
    'ts.svg': '<svg/>'
  })
  const registry = new PluginIconThemeRegistry(new PluginContentVerifier())
  await registry.reconcile([plugin], () => true)

  await expect(registry.load('plugin:samples.minimal-icons/minimal')).rejects.toThrow(
    'icons/folder.svg'
  )
  await registry.reconcile([plugin], () => false)
  expect(registry.list()).toEqual([])
})

it('changes a dev folder theme revision when an SVG is edited in place', async () => {
  const plugin = await iconPlugin({
    'folder.svg': '<svg viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>',
    'ts.svg': '<svg/>'
  })
  const registry = new PluginIconThemeRegistry(new PluginContentVerifier())
  await registry.reconcile([plugin], () => true)
  const revision = registry.list()[0]?.revision
  await registry.reconcile([plugin], () => true)
  expect(registry.list()[0]?.revision).toBe(revision)

  const svgPath = join(plugin.rootDir, 'icons', 'ts.svg')
  await writeFile(svgPath, '<svg viewBox="0 0 2 2"/>')
  // Pin a distinct mtime so coarse filesystem timestamps cannot hide the edit.
  await utimes(svgPath, new Date(2_000_000_000_000), new Date(2_000_000_000_000))
  await registry.reconcile([plugin], () => true)
  expect(registry.list()[0]?.revision).not.toBe(revision)
  const theme = await registry.load('plugin:samples.minimal-icons/minimal')
  expect(theme?.svgs[theme.fileExtensions.ts ?? -1]).toBe('<svg viewBox="0 0 2 2"/>')
})
