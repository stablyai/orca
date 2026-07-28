import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { pluginManifestSchema, type PluginManifest } from '../../shared/plugins/plugin-manifest'
import {
  PLUGIN_PANEL_ENTRY_MAX_BYTES,
  validateDeclaredPluginArtifacts,
  validatePluginInstallContent
} from './plugin-artifact-validation'
import { hashPluginTree } from './plugin-content-hash'
import { verifyHashAddressedPluginContent } from './plugin-content-integrity'
import { PluginService } from './plugin-service'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-content-test-'))
  roots.push(root)
  return root
}

type ManifestOverrides = Omit<Partial<PluginManifest>, 'contributes'> & {
  contributes?: Partial<PluginManifest['contributes']>
}

function manifest(overrides: ManifestOverrides = {}): PluginManifest {
  const { contributes, ...manifestOverrides } = overrides
  return pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'demo',
    publisher: 'orca-samples',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    capabilities: [],
    ...manifestOverrides,
    contributes
  })
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('declared plugin artifacts', () => {
  it('validates every content-pack file and directory before enablement', async () => {
    const root = await tempRoot()
    await Promise.all([
      mkdir(join(root, 'themes')),
      mkdir(join(root, 'locales')),
      mkdir(join(root, 'recipes')),
      writeFile(join(root, 'icons.json'), '{}'),
      writeFile(join(root, 'agent.json'), '{}')
    ])
    await Promise.all([
      writeFile(join(root, 'themes', 'nord.json'), '{}'),
      writeFile(join(root, 'locales', 'pt-BR.json'), '{}'),
      writeFile(join(root, 'recipes', 'vm.json'), '{}')
    ])
    const pluginManifest = manifest({
      contributes: {
        themes: [{ id: 'nord', label: 'Nord', path: 'themes/nord.json' }],
        iconThemes: [{ id: 'minimal', path: 'icons.json' }],
        languagePacks: [{ locale: 'pt-BR', path: 'locales/pt-BR.json' }],
        vmRecipes: [{ path: 'recipes/vm.json' }],
        agents: [{ path: 'agent.json' }]
      }
    })

    await expect(validateDeclaredPluginArtifacts(root, pluginManifest)).resolves.toEqual({
      ok: true
    })
  })

  it('requires declared files to exist and be regular files', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'panel.html'))

    const result = await validateDeclaredPluginArtifacts(
      root,
      manifest({
        main: 'missing-worker.js',
        contributes: {
          panels: [{ id: 'panel', title: 'Panel', entry: 'panel.html' }],
          commands: [],
          events: []
        }
      })
    )

    expect(result).toMatchObject({ ok: false })
  })

  it('refuses a panel reached through an escaping directory link or junction', async () => {
    const root = await tempRoot()
    const outsideDir = await tempRoot()
    const userDataPath = await tempRoot()
    await writeFile(join(outsideDir, 'panel.html'), '<h1>outside</h1>')
    await symlink(
      outsideDir,
      join(root, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const pluginManifest = manifest({
      contributes: {
        panels: [{ id: 'panel', title: 'Panel', entry: 'escape/panel.html' }],
        commands: [],
        events: []
      }
    })
    await writeFile(join(root, 'orca-plugin.json'), JSON.stringify(pluginManifest))

    await expect(validateDeclaredPluginArtifacts(root, pluginManifest)).resolves.toMatchObject({
      ok: false
    })

    const pluginKey = `${pluginManifest.publisher}.${pluginManifest.id}`
    const service = new PluginService({
      userDataPath,
      hostVersion: '1.4.0',
      isPluginSystemEnabled: () => true,
      getDisabledPlugins: () => [],
      getPluginConsents: () => ({
        [pluginKey]: fingerprintPluginConsent(pluginManifest)
      }),
      getDevPluginPaths: () => [root]
    })
    try {
      await service.initialize()
      await expect(service.panels.readEntry(pluginKey, 'panel')).resolves.toBeNull()
    } finally {
      await service.dispose()
    }
  })

  it('rejects a panel artifact too large to mount safely in a renderer', async () => {
    const root = await tempRoot()
    const panelPath = join(root, 'panel.html')
    await writeFile(panelPath, '')
    await truncate(panelPath, PLUGIN_PANEL_ENTRY_MAX_BYTES + 1)
    const pluginManifest = manifest({
      contributes: {
        panels: [{ id: 'panel', title: 'Panel', entry: 'panel.html' }],
        commands: [],
        events: []
      }
    })

    await expect(validateDeclaredPluginArtifacts(root, pluginManifest)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('artifact limit')
    })
  })

  it('sanitizes every icon-theme SVG at the install boundary', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'icons'))
    await writeFile(
      join(root, 'icons', 'theme.json'),
      JSON.stringify({ schemaVersion: 1, icons: { file: 'icons/file.svg' } })
    )
    await writeFile(
      join(root, 'icons', 'file.svg'),
      '<svg><path fill="&#x75;rl(https://example.com/x)"/></svg>'
    )
    const pluginManifest = manifest({
      contributes: {
        iconThemes: [{ id: 'hostile', label: 'Hostile', path: 'icons/theme.json' }]
      }
    })

    await expect(validateDeclaredPluginArtifacts(root, pluginManifest)).resolves.toEqual({
      ok: true
    })
    await expect(validatePluginInstallContent(root, pluginManifest)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('active or external content')
    })
  })

  it('parses VM recipes at the immutable install boundary', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'recipes'))
    await writeFile(
      join(root, 'recipes', 'invalid.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'cloud',
        name: 'Cloud',
        create: 'create',
        suspend: 'suspend'
      })
    )
    const pluginManifest = manifest({
      contributes: { vmRecipes: [{ path: 'recipes/invalid.json' }] }
    })

    await expect(validateDeclaredPluginArtifacts(root, pluginManifest)).resolves.toEqual({
      ok: true
    })
    await expect(validatePluginInstallContent(root, pluginManifest)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('suspend and resume')
    })
  })

  it('rejects duplicate VM recipe ids at the immutable install boundary', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'recipes'))
    const recipe = JSON.stringify({
      schemaVersion: 1,
      id: 'cloud',
      name: 'Cloud',
      create: 'create'
    })
    await Promise.all([
      writeFile(join(root, 'recipes', 'one.json'), recipe),
      writeFile(join(root, 'recipes', 'two.json'), recipe)
    ])
    const pluginManifest = manifest({
      contributes: {
        vmRecipes: [{ path: 'recipes/one.json' }, { path: 'recipes/two.json' }]
      }
    })

    await expect(validatePluginInstallContent(root, pluginManifest)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('duplicate VM recipe id "cloud"')
    })
  })
})

describe('hash-addressed plugin content', () => {
  it('uses unambiguous framing for paths and file contents', async () => {
    const first = await tempRoot()
    const second = await tempRoot()
    await writeFile(join(first, 'a'), Buffer.from('x\0b\0y'))
    await Promise.all([writeFile(join(second, 'a'), 'x'), writeFile(join(second, 'b'), 'y')])

    const [firstHash, secondHash] = await Promise.all([
      hashPluginTree(first),
      hashPluginTree(second)
    ])

    expect(firstHash).toMatchObject({ ok: true })
    expect(secondHash).toMatchObject({ ok: true })
    if (firstHash.ok && secondHash.ok) {
      expect(firstHash.hash).not.toBe(secondHash.hash)
    }
  })

  it('hashes and bounds nested .git directories as plugin content', async () => {
    const root = await tempRoot()
    const nestedGit = join(root, 'vendor', '.git')
    await mkdir(nestedGit, { recursive: true })
    const entry = join(nestedGit, 'main.mjs')
    await writeFile(entry, 'export default function activate() {}')
    const initial = await hashPluginTree(root)
    await writeFile(entry, 'export default function activate() { throw new Error("changed") }')
    const changed = await hashPluginTree(root)

    expect(initial).toMatchObject({ ok: true })
    expect(changed).toMatchObject({ ok: true })
    if (initial.ok && changed.ok) {
      expect(changed.hash).not.toBe(initial.hash)
    }

    await truncate(entry, 50 * 1024 * 1024 + 1)
    await expect(hashPluginTree(root)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('byte limit')
    })
  })

  it('does not let host locale collation change a content address', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'alpha.txt'), 'a')
    await writeFile(join(root, 'zulu.txt'), 'z')
    const expected = await hashPluginTree(root)
    vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => -1)

    const withDifferentCollation = await hashPluginTree(root)

    expect(withDifferentCollation).toEqual(expected)
  })

  it.skipIf(process.platform === 'win32')(
    'rejects Windows-reserved tree entries cross-platform',
    async () => {
      const root = await tempRoot()
      await writeFile(join(root, 'CON.txt'), 'reserved')

      await expect(hashPluginTree(root)).resolves.toMatchObject({ ok: false })
    }
  )

  it('detects content changed after its address was computed', async () => {
    const root = await tempRoot()
    const entry = join(root, 'panel.html')
    await writeFile(entry, '<h1>original</h1>')
    const initial = await hashPluginTree(root)
    expect(initial.ok).toBe(true)
    if (!initial.ok) {
      return
    }
    expect(initial.hash).toMatch(/^[0-9a-f]{64}$/)
    await expect(
      verifyHashAddressedPluginContent({
        rootDir: root,
        contentHash: initial.hash.slice(0, 32)
      })
    ).resolves.toEqual({ ok: true })

    await writeFile(entry, '<h1>tampered</h1>')

    await expect(
      verifyHashAddressedPluginContent({ rootDir: root, contentHash: initial.hash })
    ).resolves.toMatchObject({ ok: false })
  })

  it('rejects an oversized sparse file before reading it into memory', async () => {
    const root = await tempRoot()
    const oversized = join(root, 'oversized.bin')
    await writeFile(oversized, '')
    await truncate(oversized, 50 * 1024 * 1024 + 1)

    await expect(hashPluginTree(root)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('byte limit')
    })
  })
})
