import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import {
  validateDeclaredPluginArtifacts,
  validatePluginInstallContent
} from '../artifacts/plugin-artifact-validation'
import {
  declaredPluginPanelIcons,
  validatePluginPanelIconArtifacts
} from './plugin-panel-icon-artifacts'

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h22v22H1z" fill="currentColor"/></svg>'
const roots: string[] = []

async function pluginWith(icon: string, iconFile: { path: string; contents: string }) {
  const root = await mkdtemp(join(tmpdir(), 'orca-panel-icon-'))
  roots.push(root)
  await mkdir(dirname(join(root, iconFile.path)), { recursive: true })
  await writeFile(join(root, iconFile.path), iconFile.contents)
  await writeFile(join(root, 'panel.html'), '<!doctype html>')
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 2,
    execution: 'sandboxed-ui',
    id: 'icons',
    name: 'Icons',
    version: '1.0.0',
    engines: { orca: '>=1.4.260' },
    pluginApi: 1,
    contributes: {
      panels: [{ id: 'one', title: 'One', icon, entry: 'panel.html' }]
    }
  })
  return { root, manifest }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('panel icon artifacts', () => {
  it('maps file icons to their panel image slot and validates them', async () => {
    const { root, manifest } = await pluginWith('icons/panel.svg', {
      path: 'icons/panel.svg',
      contents: SVG
    })

    expect(declaredPluginPanelIcons(manifest)).toEqual([
      { path: 'icons/panel.svg', slot: 'panel-icon-0', format: 'svg' }
    ])
    await expect(validateDeclaredPluginArtifacts(root, manifest)).resolves.toEqual({ ok: true })
    await expect(validatePluginPanelIconArtifacts(root, manifest)).resolves.toEqual({ ok: true })
  })

  it('refuses SVG scripts before install', async () => {
    const script =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script></svg>'
    const { root, manifest } = await pluginWith('icons/panel.svg', {
      path: 'icons/panel.svg',
      contents: script
    })

    await expect(validatePluginInstallContent(root, manifest)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('SVG element "script" is not allowed')
    })
  })
})
