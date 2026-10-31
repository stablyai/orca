import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginFromTemplate, pluginIdFromFolder } from './plugin-create'
import { inspectPluginFolder, validatePluginTarget } from './plugin-folder-validation'
import { PLUGIN_TEMPLATE_NAMES } from './plugin-template-names'

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
  })

  it('refuses a non-empty folder and never overwrites', async () => {
    const dir = await tempRoot()
    await writeFile(join(dir, 'keep.txt'), 'mine')
    await expect(createPluginFromTemplate({ dir, template: 'theme' })).rejects.toThrow(
      'is not empty'
    )
  })

  it('rejects an id the manifest would refuse before writing anything', async () => {
    const dir = join(await tempRoot(), 'x')
    await expect(
      createPluginFromTemplate({ dir, template: 'theme', id: 'Bad Id' })
    ).rejects.toThrow('cannot create')
  })

  it('derives the id from the folder name', () => {
    expect(pluginIdFromFolder('/tmp/My Cool_Theme')).toBe('my-cool-theme')
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

  it('names a folder without a publisher the way Orca loads it', async () => {
    const dir = join(await tempRoot(), 'nopub')
    await createPluginFromTemplate({ dir, template: 'theme', publisher: 'acme' })
    const manifestPath = join(dir, 'orca-plugin.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    delete manifest.publisher
    manifest.engines.orca = '>=1.4.246'
    await writeFile(manifestPath, JSON.stringify(manifest))
    const report = await validatePluginTarget(dir)
    expect(report.errors).toEqual([])
    expect(report.plugin?.pluginKey).toBe('local.nopub')
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
