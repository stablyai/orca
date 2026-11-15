import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import { PLUGIN_MANIFEST_V2_SINCE } from '../../../shared/plugins/manifest/plugin-schema-field-docs'
import {
  readPluginNewFileTemplate,
  validatePluginInstallContent
} from '../artifacts/plugin-artifact-validation'

const roots: string[] = []

async function pluginWith(files: Record<string, Buffer>, fields: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-images-'))
  roots.push(root)
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), bytes)
  }
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 2,
    execution: 'data',
    id: 'demo',
    publisher: 'acme',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
    ...fields
  })
  return { root, manifest }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('new-file and editor artifacts', () => {
  it('reads a UTF-8 template verbatim and refuses other bytes', async () => {
    const scene = '{"type":"excalidraw","elements":[]}\n'
    const { root, manifest } = await pluginWith(
      { 'empty.a': Buffer.from(scene), 'bad.a': Buffer.from([0xff, 0xfe, 0x00]) },
      {
        contributes: {
          newFiles: [{ id: 'a', title: 'New A', extension: '.a', template: 'empty.a' }]
        }
      }
    )
    expect(await validatePluginInstallContent(root, manifest)).toEqual({ ok: true })
    await expect(readPluginNewFileTemplate(root, 'empty.a')).resolves.toBe(scene)
    await expect(readPluginNewFileTemplate(root, 'bad.a')).rejects.toThrow('is not UTF-8 text')
  })
})
