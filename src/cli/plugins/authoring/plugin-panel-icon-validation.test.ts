import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { z } from 'zod'
import {
  discoverPlugins,
  isInvalidDiscoveredPlugin
} from '../../../main/plugins/discovery/plugin-discovery'
import { PLUGIN_PANEL_PATH_ICON_SINCE } from '../../../shared/plugins/manifest/plugin-schema-field-docs'
import { createPluginFromTemplate } from './plugin-create'
import { validatePluginTarget } from './plugin-folder-validation'

const templateSchema = z.object({
  contributes: z.object({ panels: z.array(z.record(z.string(), z.unknown())) })
})

let root: string
let dir: string
let manifest: Record<string, unknown>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-panel-icon-check-'))
  dir = join(root, 'plugin')
  await createPluginFromTemplate({ dir, template: 'panel', publisher: 'acme' })
  manifest = JSON.parse(await readFile(join(dir, 'orca-plugin.json'), 'utf8'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeManifest(icon: unknown, overrides: Record<string, unknown> = {}) {
  const { panels } = templateSchema.parse(manifest).contributes
  const next = {
    ...manifest,
    engines: { orca: `>=${PLUGIN_PANEL_PATH_ICON_SINCE}` },
    ...overrides,
    contributes: { panels: [{ ...panels[0], icon }] }
  }
  await writeFile(join(dir, 'orca-plugin.json'), JSON.stringify(next))
}

async function discoveredIcon(): Promise<unknown> {
  const [plugin] = await discoverPlugins({
    pluginsDir: join(root, 'installed'),
    devPluginPaths: [dir],
    hostVersion: '99.0.0'
  })
  if (!plugin || isInvalidDiscoveredPlugin(plugin)) {
    throw new Error(`plugin did not load: ${plugin && 'error' in plugin ? plugin.error : ''}`)
  }
  return plugin.manifest.contributes.panels[0]?.icon
}

it('keeps built-in names and valid path icons without warnings', async () => {
  for (const icon of [
    'puzzle',
    'database',
    { path: 'M4 4h16v16H4z' },
    { path: 'M2 2h20v20H2z', viewBox: '0 0 24 24', mode: 'fill' },
    { path: 'M0 0L1024 1024', viewBox: '0 0 1024 1024', mode: 'stroke' }
  ]) {
    await writeManifest(icon)
    const report = await validatePluginTarget(dir)
    expect(report.errors, JSON.stringify(icon)).toEqual([])
    expect(report.warnings, JSON.stringify(icon)).toBeUndefined()
    expect(await discoveredIcon()).toEqual(icon)
  }
})

it('falls back to puzzle with a warning for icons Orca cannot draw', async () => {
  for (const [icon, reason] of [
    [{ path: 'M0 0<script>' }, 'icon.path must be SVG path data'],
    [{ path: 'L0 0' }, 'icon.path must be SVG path data'],
    [{ path: '' }, 'icon.path must not be empty'],
    [{ path: `M${' 1'.repeat(2048)}` }, 'icon.path must be at most 4096 characters'],
    [{ path: 'M0 0', viewBox: '0 0 0 24' }, 'icon.viewBox must be "0 0 W H"'],
    [{ path: 'M0 0', viewBox: '0 0 2048 24' }, 'icon.viewBox must be "0 0 W H"'],
    [{ path: 'M0 0', viewBox: '1 1 24 24' }, 'icon.viewBox must be "0 0 W H"'],
    [{ path: 'M0 0', mode: 'outline' }, 'icon.mode'],
    [{ path: 'M0 0', color: 'red' }, 'unknown key "color"'],
    [{ viewBox: '0 0 24 24' }, 'icon.path must be a string'],
    ['icons/panel.svg', 'file icons are not supported; use icon.path']
  ] as const) {
    await writeManifest(icon)
    const report = await validatePluginTarget(dir)
    expect(report.valid, JSON.stringify(icon)).toBe(true)
    expect(report.warnings, JSON.stringify(icon)).toEqual([expect.stringContaining(reason)])
    expect(report.warnings?.[0]).toContain('Showing the puzzle icon instead')
    expect(await discoveredIcon()).toBeUndefined()
  }
})

it('still refuses a misspelled built-in name', async () => {
  await writeManifest('databse')
  const report = await validatePluginTarget(dir)
  expect(report.valid).toBe(false)
})

it('requires the path icon release in engines.orca', async () => {
  await writeManifest({ path: 'M4 4h16v16H4z' }, { engines: { orca: '>=1.4.246' } })
  const report = await validatePluginTarget(dir)
  expect(report.valid).toBe(false)
  expect(report.errors.join('\n')).toContain(
    `must be at least >=${PLUGIN_PANEL_PATH_ICON_SINCE}, because contributes.panels[0].icon needs Orca ${PLUGIN_PANEL_PATH_ICON_SINCE}`
  )
  await writeManifest('database', { engines: { orca: '>=1.4.246' } })
  expect((await validatePluginTarget(dir)).valid).toBe(true)
})

it('warns that format 1 cannot use path or file icons', async () => {
  for (const [icon, reason] of [
    [{ path: 'M0 0' }, 'path icons require manifest format 2'],
    ['x.svg', 'file icons are not supported'],
    ['databse', "isn't a built-in icon name"]
  ] as const) {
    await writeManifest(icon, { manifestVersion: 1, engines: { orca: '>=1.4.160' } })
    const report = await validatePluginTarget(dir)
    expect(report.valid, JSON.stringify(icon)).toBe(true)
    expect(report.warnings?.[0], JSON.stringify(icon)).toContain(reason)
  }
})
