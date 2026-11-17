import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { createPluginFromTemplate } from '../../../cli/plugins/authoring/plugin-create'
import { pluginInstalledImageUrl } from '../../../shared/plugins/images/plugin-image-url'
import { discoverPlugins, isInvalidDiscoveredPlugin } from '../discovery/plugin-discovery'
import { createPluginImageRequestHandler } from './plugin-image-protocol'
import { PluginImageCache } from './plugin-image-cache'

vi.mock('electron', () => ({ protocol: {} }))

it('serves the discovered icon until the next discovery and falls back after a cache miss', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-panel-cache-'))
  try {
    const dir = join(root, 'plugin')
    await createPluginFromTemplate({ dir, template: 'panel', publisher: 'acme' })
    const manifestPath = join(dir, 'orca-plugin.json')
    const manifest = await readFile(manifestPath, 'utf8')
    await writeFile(manifestPath, manifest.replace('"puzzle"', '"icon.svg"'))
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0"/></svg>'
    await writeFile(join(dir, 'icon.svg'), svg)
    const discover = async () => {
      const [plugin] = await discoverPlugins({
        pluginsDir: join(root, 'installed'),
        devPluginPaths: [dir],
        hostVersion: '99.0.0'
      })
      if (!plugin || isInvalidDiscoveredPlugin(plugin)) {
        throw new Error('discovery failed')
      }
      return plugin
    }
    let plugin = await discover()
    const handler = createPluginImageRequestHandler({
      cache: new PluginImageCache(join(root, 'cache')),
      findValidPlugin: () => plugin,
      findApprovedPlugin: () => null
    })
    const url = pluginInstalledImageUrl(plugin.pluginKey, 'dev', 'panel-0')
    expect(await (await handler(new Request(url))).text()).toBe(svg)
    await rm(join(dir, 'icon.svg'))
    expect(await (await handler(new Request(url))).text()).toBe(svg)
    plugin = await discover()
    expect(plugin.manifest.contributes.panels[0]?.icon).toBe('plug')
    expect((await handler(new Request(url))).status).toBe(404)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32')(
  'rejects symlinks and FIFOs during discovery',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-panel-fifo-'))
    try {
      const dir = join(root, 'plugin')
      await createPluginFromTemplate({ dir, template: 'panel', publisher: 'acme' })
      const manifestPath = join(dir, 'orca-plugin.json')
      await writeFile(
        manifestPath,
        (await readFile(manifestPath, 'utf8')).replace('"puzzle"', '"icon.svg"')
      )
      const icon = join(dir, 'icon.svg')
      await writeFile(
        join(dir, 'target.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>'
      )
      await symlink('target.svg', icon)
      const discover = () =>
        discoverPlugins({
          pluginsDir: join(root, 'installed'),
          devPluginPaths: [dir],
          hostVersion: '99.0.0'
        })
      for (const kind of ['symlink', 'fifo']) {
        if (kind === 'fifo') {
          await rm(icon)
          await promisify(execFile)('mkfifo', [icon])
        }
        const [plugin] = await discover()
        expect(
          plugin &&
            !isInvalidDiscoveredPlugin(plugin) &&
            plugin.manifest.contributes.panels[0]?.icon
        ).toBe('plug')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  15000
)
