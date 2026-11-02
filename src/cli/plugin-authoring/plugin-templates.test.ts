import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginFromTemplate } from './plugin-create'
import { inspectPluginFolder, validatePluginTarget } from './plugin-folder-validation'
import { PLUGIN_TEMPLATE_NAMES } from './plugin-template-names'
import { PLUGIN_SOURCE_MODULES_SINCE } from '../../shared/plugins/manifest/plugin-schema-field-docs'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-create-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('orca plugin create templates', () => {
  it.each(PLUGIN_TEMPLATE_NAMES)('%s scaffolds a plugin that validates as-is', async (template) => {
    const dir = join(await tempRoot(), `my-${template}`)
    const created = await createPluginFromTemplate({ dir, template, publisher: 'acme' })
    expect(created.pluginKey).toBe(`acme.my-${template}`)
    const report = await inspectPluginFolder(dir)
    expect(report.errors).toEqual([])
    expect(report.valid).toBe(true)
    expect(report.contentHash).toMatch(/^[0-9a-f]{64}$/)
    const contentOnly = ['theme', 'terminal-theme', 'icon-theme', 'syntax', 'language-pack']
    expect(report.plugin?.needsApproval).toBe(!contentOnly.includes(template))
    const readme = await readFile(join(dir, 'README.md'), 'utf8')
    expect(readme).toContain('orca plugin dev watch .')
    expect(readme).not.toContain('dev load')
  })

  it.each(PLUGIN_TEMPLATE_NAMES)(
    '%s leaves publisher out by default, with the lowest engines.orca that allows it',
    async (template) => {
      const dir = join(await tempRoot(), `bare-${template}`)
      const created = await createPluginFromTemplate({ dir, template })
      expect(created.pluginKey).toBe(`local.bare-${template}`)
      const manifest = JSON.parse(await readFile(join(dir, 'orca-plugin.json'), 'utf8'))
      expect(manifest.publisher).toBeUndefined()
      expect(manifest.engines.orca).toBe(`>=${PLUGIN_SOURCE_MODULES_SINCE}`)
      const report = await validatePluginTarget(dir)
      expect(report.errors).toEqual([])
    }
  )

  it('components writes a build-less TSX panel and its gitignored typings', async () => {
    const dir = join(await tempRoot(), 'todo-panel')
    const created = await createPluginFromTemplate({ dir, template: 'components' })
    expect(created.files).toEqual(
      expect.arrayContaining(['orca-plugin.json', 'src/panel.tsx', 'tsconfig.json', '.gitignore'])
    )
    expect(created.files.some((file) => file.startsWith('dist/') || file.includes('build'))).toBe(
      false
    )
    expect(created.typeFiles).toContain('.orca/types/orca/index.d.ts')
    expect(JSON.parse(await readFile(join(dir, 'tsconfig.json'), 'utf8')).extends).toBe(
      './.orca/types/tsconfig.json'
    )
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toContain('.orca/')
  })

  it('refuses a non-empty folder and never overwrites', async () => {
    const dir = await tempRoot()
    await writeFile(join(dir, 'keep.txt'), 'mine')
    await expect(createPluginFromTemplate({ dir, template: 'theme' })).rejects.toThrow(
      'is not empty'
    )
  })
})

describe('orca plugin validate', () => {
  it('reports artifact errors Orca would otherwise skip silently', async () => {
    const dir = join(await tempRoot(), 'broken')
    await createPluginFromTemplate({ dir, template: 'theme', publisher: 'acme' })
    await writeFile(
      join(dir, 'themes', 'dark.json'),
      JSON.stringify({ base: 'dark', tokens: { '--background': '#000', '--fooground': '#fff' } })
    )
    const report = await validatePluginTarget(dir)
    expect(report.valid).toBe(false)
    expect(report.errors.join('\n')).toContain('contributes.themes')
  })

  it('reports a missing panel entry', async () => {
    const dir = join(await tempRoot(), 'panel')
    await createPluginFromTemplate({ dir, template: 'panel', publisher: 'acme' })
    await rm(join(dir, 'panel', 'index.html'))
    const report = await validatePluginTarget(dir)
    expect(report.valid).toBe(false)
    expect(report.errors.join('\n')).toContain('panel/index.html')
  })
})
