import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createPluginFromTemplate } from './plugin-create'
import { validatePluginTarget } from './plugin-folder-validation'

it('warns when a panel icon cannot be used', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-panel-icon-check-'))
  try {
    const dir = join(root, 'plugin')
    await createPluginFromTemplate({ dir, template: 'panel', publisher: 'acme' })
    const file = join(dir, 'orca-plugin.json')
    const original = await readFile(file, 'utf8')
    await writeFile(file, original.replace('"puzzle"', '"../escape.svg"'))
    const report = await validatePluginTarget(dir)
    expect(report.valid).toBe(true)
    expect(report.warnings).toEqual([expect.stringContaining('using plug')])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
