import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverPlugins } from './plugin-discovery'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempPluginsDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-discovery-'))
  roots.push(root)
  return root
}

describe('installed plugin discovery identity', () => {
  // Regression: Excalidraw 1.0.0 as installed from the catalog before the format 2 floor moved.
  it('loads an installed manifest whose engines floor predates its fields, but not a dev copy', async () => {
    const pluginsDir = await tempPluginsDir()
    const devDir = await tempPluginsDir()
    const hash = 'c'.repeat(64)
    const versionDir = join(pluginsDir, 'stablyai.orca-excalidraw', hash)
    const manifest = JSON.stringify({
      manifestVersion: 2,
      id: 'orca-excalidraw',
      publisher: 'stablyai',
      name: 'Excalidraw',
      version: '1.0.0',
      execution: 'sandboxed-ui',
      engines: { orca: '>=1.4.244' },
      contributes: {
        customEditors: [
          {
            id: 'excalidraw',
            title: 'Excalidraw',
            extensions: ['.excalidraw', '.excalidraw.json'],
            entry: 'editor/index.html',
            priority: 'default'
          }
        ]
      },
      capabilities: []
    })
    for (const dir of [versionDir, devDir]) {
      await mkdir(join(dir, 'editor'), { recursive: true })
      await writeFile(join(dir, 'orca-plugin.json'), manifest)
      await writeFile(join(dir, 'editor', 'index.html'), '<p>editor</p>')
    }
    await writeFile(join(pluginsDir, 'stablyai.orca-excalidraw', 'current'), hash)

    const [installed] = await discoverPlugins({
      pluginsDir,
      devPluginPaths: [],
      hostVersion: '1.4.245'
    })
    expect(installed && 'error' in installed ? installed.error : null).toBeNull()
    expect(installed?.pluginKey).toBe('stablyai.orca-excalidraw')

    const [dev] = await discoverPlugins({
      pluginsDir: await tempPluginsDir(),
      devPluginPaths: [devDir],
      hostVersion: '1.4.245'
    })
    expect(dev && 'error' in dev ? dev.error : '').toContain('engines.orca: must be at least')

    // An older host still names the version gap rather than a schema error.
    const [old] = await discoverPlugins({ pluginsDir, devPluginPaths: [], hostVersion: '1.4.200' })
    expect(old && 'error' in old ? old.error : '').toBe('requires Orca >=1.4.244 (this is 1.4.200)')
  })
})
