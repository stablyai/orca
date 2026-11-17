import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginFromTemplate } from './plugin-create'
import { inspectPluginFolder } from './plugin-folder-validation'
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
    const readme = await readFile(join(dir, 'README.md'), 'utf8')
    expect(readme).toContain('orca plugin dev watch .')
    expect(readme).not.toContain('dev load')
  })
})
