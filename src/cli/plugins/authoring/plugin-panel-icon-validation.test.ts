import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  discoverPlugins,
  isInvalidDiscoveredPlugin
} from '../../../main/plugins/discovery/plugin-discovery'
import { pluginManifestWarnings } from '../../../shared/plugins/installation/plugin-file-validation'
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

it(
  'keeps built-in names and valid path icons without warnings',
  async () => {
    for (const icon of [
      'puzzle',
      'database',
      { path: 'M4 4h16v16H4z' },
      { path: 'M2 2h20v20H2z', viewBox: '0 0 24 24', mode: 'fill' },
      { path: 'M0 0l1-1 .5.5A1 1 0 00 2 2', viewBox: '0 0 48 48' },
      { path: 'M0 0L1024 1024', viewBox: '0 0 1024 1024', mode: 'fill' }
    ]) {
      await writeManifest(icon)
      const report = await validatePluginTarget(dir)
      expect(report.errors, JSON.stringify(icon)).toEqual([])
      expect(report.warnings, JSON.stringify(icon)).toBeUndefined()
      expect(await discoveredIcon()).toEqual(icon)
    }
  },
  // Each case writes a plugin and runs full validation and discovery, slow on a loaded runner.
  60_000
)

it(
  'falls back to puzzle with a warning for icons Orca cannot draw',
  async () => {
    for (const [icon, reason] of [
      [{ path: 'M0 0<script>' }, 'icon.path must be SVG path data'],
      [{ path: 'L0 0' }, 'icon.path must be SVG path data'],
      [{ path: 'M0 0L1' }, 'icon.path command "L" at position 5 needs 2 numbers per segment'],
      [
        { path: 'M0 0A1 1 0 2 1 2 2' },
        'icon.path has an arc flag at position 12 that is not 0 or 1'
      ],
      [{ path: 'M0\u00a00' }, 'icon.path must be SVG path data'],
      [{ path: 'M0 0,' }, 'icon.path has a comma'],
      // Why: Chromium draws nothing for `1.` and stops the path at a number past float range.
      [{ path: 'M1. 2.L-.5-1.5' }, 'icon.path has a number at position 2 that ends with a dot'],
      [{ path: 'M0 0L1e39 1' }, 'icon.path has a number at position 6 that is too large to draw'],
      // Why: a 39-digit integer part draws only the first segment in Chromium, with no warning.
      [
        { path: 'M2 2H340282350000000000000000000000000000000e-38M8 8h8' },
        'icon.path has a number at position 6 that is too large to draw'
      ],
      [{ path: '' }, 'icon.path must not be empty'],
      [{ path: `M${' 1'.repeat(2048)}` }, 'icon.path must be at most 4096 characters'],
      [{ path: 'M0 0', viewBox: '0 0 0 24' }, 'icon.viewBox must be "0 0 W H"'],
      [{ path: 'M0 0', viewBox: '0 0 2048 24' }, 'icon.viewBox must be "0 0 W H"'],
      [{ path: 'M0 0', viewBox: '0 0 1025 24' }, 'icon.viewBox must be "0 0 W H"'],
      [{ path: 'M0 0', viewBox: '1 1 24 24' }, 'icon.viewBox must be "0 0 W H"'],
      [{ path: 'M0 0', mode: 'outline' }, 'icon.mode'],
      [{ path: 'M0 0', color: 'red' }, 'unknown key "color"'],
      [{}, 'icon.path must be a string'],
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
  },
  // Each case writes a plugin and runs full validation and discovery, slow on a loaded runner.
  60_000
)

it(
  'keeps other non-name icon values as manifest errors',
  async () => {
    for (const icon of ['databse', null, [], ['M0 0'], 42, true]) {
      await writeManifest(icon)
      const report = await validatePluginTarget(dir)
      expect(report.valid, JSON.stringify(icon)).toBe(false)
      expect(report.errors.join('\n'), JSON.stringify(icon)).toContain('contributes.panels[0].icon')
    }
  },
  // Each case writes a plugin and runs full validation and discovery, slow on a loaded runner.
  60_000
)

it('warns that a 2-unit stroke is thin in a viewBox larger than 48', async () => {
  await writeManifest({ path: 'M0 0L96 96', viewBox: '0 0 96 96' })
  const report = await validatePluginTarget(dir)
  expect(report.valid).toBe(true)
  expect(report.warnings).toEqual([expect.stringContaining('sized for a viewBox of about 24')])
  expect(await discoveredIcon()).toEqual({ path: 'M0 0L96 96', viewBox: '0 0 96 96' })
  await writeManifest({ path: 'M0 0L96 96', viewBox: '0 0 96 96', mode: 'fill' })
  expect((await validatePluginTarget(dir)).warnings).toBeUndefined()
})

it('keeps manifest text in icon warnings on one line', async () => {
  const { panels } = templateSchema.parse(manifest).contributes
  await writeFile(
    join(dir, 'orca-plugin.json'),
    JSON.stringify({
      ...manifest,
      engines: { orca: `>=${PLUGIN_PANEL_PATH_ICON_SINCE}` },
      contributes: {
        panels: [{ ...panels[0], icon: { path: 'M0 0', 'x\nINFO forged\u001b[2K': 1 } }]
      }
    })
  )
  const warnings = (await validatePluginTarget(dir)).warnings ?? []
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).not.toMatch(/\p{Cc}/u)
  expect(warnings[0]).toContain('x INFO forged')
})

it('requires the path icon release in engines.orca', async () => {
  await writeManifest({ path: 'M4 4h16v16H4z' }, { engines: { orca: '>=1.4.272' } })
  const report = await validatePluginTarget(dir)
  expect(report.valid).toBe(false)
  expect(report.errors.join('\n')).toContain(
    `must be at least >=${PLUGIN_PANEL_PATH_ICON_SINCE}, because contributes.panels[0].icon needs Orca ${PLUGIN_PANEL_PATH_ICON_SINCE}`
  )
  await writeManifest('database', { engines: { orca: '>=1.4.246' } })
  expect((await validatePluginTarget(dir)).valid).toBe(true)
})

it(
  'requires the path icon release for icons it drops as well',
  async () => {
    // Why: an older Orca refuses these outright, so the plugin would not load there at all.
    for (const icon of [{ path: 'nope' }, { color: 'red' }, 'icons/panel.svg']) {
      await writeManifest(icon, { engines: { orca: '>=1.4.246' } })
      const report = await validatePluginTarget(dir)
      expect(report.valid, JSON.stringify(icon)).toBe(false)
      expect(report.errors.join('\n'), JSON.stringify(icon)).toContain(
        `must be at least >=${PLUGIN_PANEL_PATH_ICON_SINCE}, because contributes.panels[0].icon needs Orca ${PLUGIN_PANEL_PATH_ICON_SINCE}`
      )
    }
  },
  // Each case writes a plugin and runs full validation and discovery, slow on a loaded runner.
  60_000
)

it('reports icon warnings through validate:plugin', async () => {
  await writeManifest({ path: 'M0 0L1' })
  const raw = JSON.parse(await readFile(join(dir, 'orca-plugin.json'), 'utf8'))
  expect(pluginManifestWarnings(raw)).toContainEqual(
    expect.stringContaining('Showing the puzzle icon instead')
  )
  await writeManifest('x.svg', { manifestVersion: 1, engines: { orca: '>=1.4.160' } })
  const legacy = JSON.parse(await readFile(join(dir, 'orca-plugin.json'), 'utf8'))
  expect(pluginManifestWarnings(legacy)).toEqual([
    expect.stringContaining('file icons are not supported')
  ])
})

it(
  'warns that format 1 cannot use path or file icons',
  async () => {
    for (const [icon, reason] of [
      [{ path: 'M0 0' }, 'path icons require manifest format 2'],
      ['x.svg', 'file icons are not supported'],
      ['databse', "isn't a built-in icon name"]
    ] as const) {
      await writeManifest(icon, { manifestVersion: 1, engines: { orca: '>=1.4.160' } })
      const report = await validatePluginTarget(dir)
      expect(report.valid, JSON.stringify(icon)).toBe(true)
      expect(report.warnings?.[0], JSON.stringify(icon)).toContain(reason)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        expect(await discoveredIcon()).toBeUndefined()
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(reason))
      } finally {
        warn.mockRestore()
      }
    }
  },
  // Each case writes a plugin and runs full validation and discovery, slow on a loaded runner.
  60_000
)

it('reports a repeated icon warning once, and logs it once across discovery refreshes', async () => {
  const { panels } = templateSchema.parse(manifest).contributes
  const broken = { ...panels[0], icon: { path: 'M0 0L1' } }
  await writeFile(
    join(dir, 'orca-plugin.json'),
    JSON.stringify({
      ...manifest,
      engines: { orca: `>=${PLUGIN_PANEL_PATH_ICON_SINCE}` },
      contributes: { panels: [broken, { ...broken, id: 'second' }] }
    })
  )
  expect((await validatePluginTarget(dir)).warnings).toEqual([
    expect.stringContaining('Showing the puzzle icon instead')
  ])
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await discoveredIcon()
    await discoveredIcon()
    const iconWarnings = warn.mock.calls.filter(([message]) =>
      String(message).includes('Showing the puzzle icon instead')
    )
    expect(iconWarnings).toHaveLength(1)
  } finally {
    warn.mockRestore()
  }
})
