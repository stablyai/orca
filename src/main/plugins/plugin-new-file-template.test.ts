import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pluginManifestSchema } from '../../shared/plugins/manifest/plugin-manifest'
import { PLUGIN_MANIFEST_V2_SINCE } from '../../shared/plugins/manifest/plugin-schema-field-docs'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { readApprovedPluginNewFileTemplate } from './plugin-new-file-template'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function drawPlugin(): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-new-file-'))
  roots.push(rootDir)
  await writeFile(join(rootDir, 'empty.draw'), '{"elements":[]}\n')
  return {
    pluginKey: 'acme.draw',
    rootDir,
    consentFingerprint: 'x',
    contentHash: 'a'.repeat(64),
    isDev: false,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 2,
      execution: 'data',
      id: 'draw',
      publisher: 'acme',
      name: 'Draw',
      version: '1.0.0',
      engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
      contributes: {
        newFiles: [
          { id: 'scene', title: 'New scene', extension: '.draw', template: 'empty.draw' },
          { id: 'blank', title: 'New blank', extension: '.draw' }
        ]
      }
    })
  }
}

describe('readApprovedPluginNewFileTemplate', () => {
  it("reads an approved plugin's template, or empty text without one", async () => {
    const plugin = await drawPlugin()
    const service = { findApprovedPlugin: () => plugin }
    await expect(
      readApprovedPluginNewFileTemplate(service, plugin.pluginKey, 'scene')
    ).resolves.toBe('{"elements":[]}\n')
    await expect(
      readApprovedPluginNewFileTemplate(service, plugin.pluginKey, 'blank')
    ).resolves.toBe('')
    await expect(
      readApprovedPluginNewFileTemplate(service, plugin.pluginKey, 'missing')
    ).resolves.toBeNull()
  })

  it('hands nothing out for a plugin that is off or awaiting review', async () => {
    await expect(
      readApprovedPluginNewFileTemplate({ findApprovedPlugin: () => null }, 'acme.draw', 'scene')
    ).resolves.toBeNull()
  })
})
