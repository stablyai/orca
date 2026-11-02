import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pluginManifestSchema } from '../../shared/plugins/manifest/plugin-manifest'
import { PLUGIN_MANIFEST_V2_SINCE } from '../../shared/plugins/manifest/plugin-schema-field-docs'
import {
  readPluginNewFileTemplate,
  validatePluginInstallContent
} from './plugin-artifact-validation'

const roots: string[] = []
const be32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]

function png(width: number, height: number): Buffer {
  return Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    ...Buffer.from('IHDR'),
    ...be32(width),
    ...be32(height),
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...Buffer.from('IEND'),
    0,
    0,
    0,
    0
  ])
}

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

describe('plugin image artifacts', () => {
  it('accepts images that meet their rules', async () => {
    const { root, manifest } = await pluginWith(
      { 'icon.png': png(512, 512), 'cover.png': png(1600, 1000), 'shot.png': png(1280, 800) },
      {
        icon: 'icon.png',
        cover: { path: 'cover.png', alt: 'The theme' },
        screenshots: [{ path: 'shot.png', alt: 'The editor' }]
      }
    )
    await expect(validatePluginInstallContent(root, manifest)).resolves.toEqual({ ok: true })
  })

  it.each([
    [
      'an SVG icon',
      { 'icon.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') },
      { icon: 'icon.svg' },
      'icon icon.svg: must be a PNG, JPEG or WebP image'
    ],
    [
      'a small cover',
      { 'cover.png': png(640, 400) },
      { cover: { path: 'cover.png', alt: 'x' } },
      'cover cover.png: cover must be at least 800×500'
    ],
    [
      'a non-square icon',
      { 'icon.png': png(512, 256) },
      { icon: 'icon.png' },
      'icon icon.png: icon must be square'
    ]
  ])('refuses %s', async (_label, files, fields, error) => {
    const { root, manifest } = await pluginWith(files, fields)
    await expect(validatePluginInstallContent(root, manifest)).resolves.toEqual({
      ok: false,
      error
    })
  })

  it('requires alt text and caps screenshots', () => {
    const base = {
      manifestVersion: 2,
      execution: 'data',
      id: 'demo',
      publisher: 'acme',
      name: 'Demo',
      version: '1.0.0',
      engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` }
    }
    expect(pluginManifestSchema.safeParse({ ...base, cover: { path: 'c.png' } }).success).toBe(
      false
    )
    expect(
      pluginManifestSchema.safeParse({
        ...base,
        screenshots: Array.from({ length: 7 }, (_, i) => ({ path: `s${i}.png`, alt: 'x' }))
      }).success
    ).toBe(false)
  })
})

describe('new-file and editor artifacts', () => {
  it('holds editor and new-file icons to the plugin icon rules', async () => {
    const { root, manifest } = await pluginWith(
      { 'tab.png': png(256, 128) },
      { contributes: { newFiles: [{ id: 'a', title: 'New A', extension: '.a', icon: 'tab.png' }] } }
    )
    expect(await validatePluginInstallContent(root, manifest)).toEqual({
      ok: false,
      error: 'icon tab.png: icon must be square'
    })
  })

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
