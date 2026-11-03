import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pluginFolderWantsTypes } from './plugin-type-files'
import { createPluginFromTemplate } from './plugin-create'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-types-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('orca plugin types', () => {
  it('refreshes on dev load only for folders that use TypeScript or components panels', async () => {
    const root = await tempRoot()
    const html = join(root, 'html-panel')
    await createPluginFromTemplate({ dir: html, template: 'panel' })
    expect(await pluginFolderWantsTypes(html)).toBe(false)
    const tsx = join(root, 'tsx-panel')
    await createPluginFromTemplate({ dir: tsx, template: 'components' })
    await rm(join(tsx, '.orca'), { recursive: true })
    expect(await pluginFolderWantsTypes(tsx)).toBe(true)
    const configured = join(root, 'configured')
    await mkdir(configured)
    await writeFile(join(configured, 'tsconfig.json'), '{"extends":"./.orca/types/tsconfig.json"}')
    expect(await pluginFolderWantsTypes(configured)).toBe(true)
  })
})
