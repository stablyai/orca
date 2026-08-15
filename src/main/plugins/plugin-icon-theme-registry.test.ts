import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { resolvePluginFileIconUrl } from '../../shared/plugins/plugin-file-icon-resolution'
import { hashPluginTree } from './plugin-content-hash'
import { PluginContentVerifier } from './plugin-content-integrity'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { PluginIconThemeRegistry } from './plugin-icon-theme-registry'

const roots: string[] = []
const escapeTargets: string[] = []

afterEach(async () => {
  await Promise.all([
    ...roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    ...escapeTargets.splice(0).map((target) => rm(target, { force: true }))
  ])
})

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect/></svg>'

async function iconThemePlugin(options: {
  id?: string
  theme?: unknown
  icons?: Record<string, string>
}): Promise<ValidDiscoveredPlugin> {
  const id = options.id ?? 'demo-file-icons'
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-icon-theme-'))
  roots.push(rootDir)
  await mkdir(join(rootDir, 'icons'))
  const icons = options.icons ?? { 'ts.svg': SVG }
  await Promise.all(
    Object.entries(icons).map(([name, svg]) => writeFile(join(rootDir, 'icons', name), svg, 'utf8'))
  )
  const theme = options.theme ?? {
    iconDefinitions: { ts: 'icons/ts.svg' },
    fileExtensions: { ts: 'ts' }
  }
  await writeFile(join(rootDir, 'icon-theme.json'), JSON.stringify(theme), 'utf8')
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 1,
    id,
    publisher: 'orca-samples',
    name: id,
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: { iconThemes: [{ id: 'demo', label: 'Demo Icons', path: 'icon-theme.json' }] },
    capabilities: []
  })
  const content = await hashPluginTree(rootDir)
  if (!content.ok) {
    throw new Error(content.error)
  }
  return {
    pluginKey: `orca-samples.${id}`,
    rootDir,
    manifest,
    consentFingerprint: fingerprintPluginConsent(manifest, content.hash),
    consentContentHash: content.hash,
    contentHash: null,
    isDev: true
  }
}

function registry(): PluginIconThemeRegistry {
  return new PluginIconThemeRegistry(new PluginContentVerifier())
}

const approveAll = (): boolean => true

describe('PluginIconThemeRegistry', () => {
  it('publishes a contributed theme with icons inlined as data URLs', async () => {
    const subject = registry()
    await subject.reconcile([await iconThemePlugin({})], approveAll)

    const [theme] = subject.list()
    expect(theme).toBeDefined()
    expect(theme?.id).toBe('orca-samples.demo-file-icons#demo')
    expect(theme?.label).toBe('Demo Icons')
    expect(theme?.icons.ts).toBe(
      `data:image/svg+xml;base64,${Buffer.from(SVG, 'utf8').toString('base64')}`
    )
    expect(subject.error('orca-samples.demo-file-icons')).toBeNull()
  })

  it('resolves a file through the published theme end to end', async () => {
    const subject = registry()
    await subject.reconcile([await iconThemePlugin({})], approveAll)

    const url = resolvePluginFileIconUrl(subject.list()[0] ?? null, 'src/index.ts')
    expect(url).toBe(`data:image/svg+xml;base64,${Buffer.from(SVG, 'utf8').toString('base64')}`)
  })

  it('drops the plugin and records an error when an icon carries script', async () => {
    const subject = registry()
    await subject.reconcile(
      [await iconThemePlugin({ icons: { 'ts.svg': '<svg><script>alert(1)</script></svg>' } })],
      approveAll
    )

    expect(subject.list()).toEqual([])
    expect(subject.error('orca-samples.demo-file-icons')).toContain('script element')
  })

  it('rejects an icon path that escapes the plugin directory', async () => {
    // Sits in the plugin root's parent so the path resolves to a real file and
    // containment — not ENOENT — is what rejects it.
    const escapeTarget = join(tmpdir(), 'orca-plugin-icon-escape-target.svg')
    await writeFile(escapeTarget, SVG, 'utf8')
    escapeTargets.push(escapeTarget)
    const subject = registry()
    await subject.reconcile(
      [
        await iconThemePlugin({
          theme: {
            iconDefinitions: { ts: '../orca-plugin-icon-escape-target.svg' },
            fileExtensions: { ts: 'ts' }
          }
        })
      ],
      approveAll
    )

    expect(subject.list()).toEqual([])
    expect(subject.error('orca-samples.demo-file-icons')).toContain(
      'resolves outside the plugin directory'
    )
  })

  // Why: creating a symlink on Windows needs elevation or Developer Mode.
  it.skipIf(process.platform === 'win32')(
    'rejects an icon symlinked out of the plugin directory',
    async () => {
      const outside = await mkdtemp(join(tmpdir(), 'orca-plugin-icon-symlink-'))
      roots.push(outside)
      const secret = join(outside, 'secret.svg')
      await writeFile(secret, SVG, 'utf8')
      const plugin = await iconThemePlugin({})
      await symlink(resolve(secret), join(plugin.rootDir, 'icons', 'linked.svg'))
      await writeFile(
        join(plugin.rootDir, 'icon-theme.json'),
        JSON.stringify({
          iconDefinitions: { ts: 'icons/linked.svg' },
          fileExtensions: { ts: 'ts' }
        }),
        'utf8'
      )
      const subject = registry()
      await subject.reconcile([plugin], approveAll)

      expect(subject.list()).toEqual([])
      expect(subject.error('orca-samples.demo-file-icons')).toContain(
        'resolves outside the plugin directory'
      )
    }
  )

  it('excludes a plugin the approval predicate rejects', async () => {
    const subject = registry()
    await subject.reconcile([await iconThemePlugin({})], () => false)
    expect(subject.list()).toEqual([])
  })

  it('clears a previously published theme once the plugin disappears', async () => {
    const subject = registry()
    await subject.reconcile([await iconThemePlugin({})], approveAll)
    expect(subject.list()).toHaveLength(1)

    await subject.reconcile([], approveAll)
    expect(subject.list()).toEqual([])
    expect(subject.error('orca-samples.demo-file-icons')).toBeNull()
  })

  // Guards the shipped authoring example against drifting out of validity.
  it('loads the checked-in demo-file-icons example from disk', async () => {
    const rootDir = fileURLToPath(
      new URL('../../../examples/plugins/demo-file-icons', import.meta.url)
    )
    const manifest = pluginManifestSchema.parse(
      JSON.parse(await readFile(join(rootDir, 'orca-plugin.json'), 'utf8'))
    )
    const content = await hashPluginTree(rootDir)
    if (!content.ok) {
      throw new Error(content.error)
    }
    const subject = registry()
    await subject.reconcile(
      [
        {
          pluginKey: 'orca-samples.demo-file-icons',
          rootDir,
          manifest,
          consentFingerprint: fingerprintPluginConsent(manifest, content.hash),
          consentContentHash: content.hash,
          contentHash: null,
          isDev: true
        }
      ],
      approveAll
    )

    expect(subject.error('orca-samples.demo-file-icons')).toBeNull()
    const theme = subject.list()[0]
    expect(theme?.label).toBe('Demo Icons')
    expect(Object.keys(theme?.icons ?? {})).toHaveLength(17)
    for (const [file, expectedDefinition] of [
      ['src/index.ts', 'typescript'],
      ['src/App.tsx', 'react'],
      ['package.json', 'npm'],
      ['README.md', 'markdown'],
      ['pnpm-lock.yaml', 'npm'],
      ['main.rs', 'rust'],
      ['anything.unknown', 'file']
    ] as const) {
      expect(resolvePluginFileIconUrl(theme, file)).toBe(theme?.icons[expectedDefinition])
    }
  })

  it('keeps themes from separate plugins distinct', async () => {
    const subject = registry()
    await subject.reconcile(
      [await iconThemePlugin({ id: 'icons-a' }), await iconThemePlugin({ id: 'icons-b' })],
      approveAll
    )

    expect(
      subject
        .list()
        .map((theme) => theme.id)
        .sort()
    ).toEqual(['orca-samples.icons-a#demo', 'orca-samples.icons-b#demo'])
  })
})
