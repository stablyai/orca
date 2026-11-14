import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  discoverPlugins,
  isInvalidDiscoveredPlugin
} from '../../../main/plugins/discovery/plugin-discovery'
import { createPluginFromTemplate } from './plugin-create'
import { validatePluginTarget } from './plugin-folder-validation'

it('warns and falls back for unsafe panel icons while preserving valid icons', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-panel-icon-check-'))
  try {
    const dir = join(root, 'plugin')
    await createPluginFromTemplate({ dir, template: 'panel', publisher: 'acme' })
    const file = join(dir, 'orca-plugin.json')
    const original = await readFile(file, 'utf8')
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0"/></svg>'
    const cases = [
      { icon: '../escape.svg', content: svg },
      { icon: 'icon.png', content: svg },
      { icon: 'icon.svg', content: 'x'.repeat(32769) },
      { icon: 'icon.svg', content: '<svg viewBox="0 0 24 24">' },
      { icon: 'icon.svg', content: '<svg viewBox="0 0 24 24"><script/></svg>' },
      { icon: 'icon.svg', content: '<svg viewBox="0 0 24 24"><foreignObject/></svg>' },
      { icon: 'icon.svg', content: '<svg viewBox="0 0 24 24"><path onclick="x"/></svg>' },
      {
        icon: 'icon.svg',
        content: '<svg viewBox="0 0 24 24"><image href="https://example.com"/></svg>'
      }
    ]
    for (const { icon, content } of cases) {
      await writeFile(join(dir, 'icon.svg'), content)
      await writeFile(file, original.replace('"puzzle"', JSON.stringify(icon)))
      const report = await validatePluginTarget(dir)
      expect(report.valid, icon).toBe(true)
      expect(report.warnings, icon).toEqual([expect.stringContaining('using plug')])
      const [plugin] = await discoverPlugins({
        pluginsDir: join(root, 'installed'),
        devPluginPaths: [dir],
        hostVersion: '99.0.0'
      })
      expect(
        plugin && !isInvalidDiscoveredPlugin(plugin) && plugin.manifest.contributes.panels[0]?.icon,
        icon
      ).toBe('plug')
    }
    for (const icon of ['puzzle', 'icon.svg']) {
      await writeFile(join(dir, 'icon.svg'), svg)
      await writeFile(file, original.replace('"puzzle"', JSON.stringify(icon)))
      const [plugin] = await discoverPlugins({
        pluginsDir: join(root, 'installed'),
        devPluginPaths: [dir],
        hostVersion: '99.0.0'
      })
      expect(
        plugin && !isInvalidDiscoveredPlugin(plugin) && plugin.manifest.contributes.panels[0]?.icon
      ).toBe(icon)
      expect((await validatePluginTarget(dir)).warnings).toBeUndefined()
    }
    await writeFile(
      file,
      original
        .replace('"manifestVersion": 2', '"manifestVersion": 1')
        .replace('"puzzle"', '"icon.svg"')
    )
    const legacy = await validatePluginTarget(dir)
    expect(legacy.valid).toBe(true)
    expect(legacy.warnings).toEqual([expect.stringContaining('require manifest format 2')])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
