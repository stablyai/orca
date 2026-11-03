import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  pluginFolderWantsTypes,
  readOrcaAuthorTypings,
  readOrcaPluginTypings,
  writePluginTypeFiles
} from './plugin-type-files'
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
  it('copies Orca typings and a tsconfig to extend into .orca/types, which ignores itself', async () => {
    const dir = await tempRoot()
    const files = await writePluginTypeFiles(dir)
    expect(files).toEqual([
      '.orca/.gitignore',
      '.orca/types/orca/index.d.ts',
      '.orca/types/orca-host/index.d.ts',
      '.orca/types/orca-frame/index.d.ts',
      '.orca/types/orca-worker/index.d.ts',
      '.orca/types/orca-services/index.d.ts',
      '.orca/types/orca-testing/index.d.ts',
      '.orca/types/tsconfig.json'
    ])
    const read = (folder: string) =>
      readFile(join(dir, '.orca', 'types', folder, 'index.d.ts'), 'utf8')
    const sources = await readOrcaAuthorTypings()
    for (const [folder, text] of Object.entries(sources)) {
      expect(await read(folder)).toContain(text)
    }
    expect(sources.orca).toBe(await readOrcaPluginTypings())
    expect(await read('orca')).toContain("declare module 'orca'")
    expect(await read('orca-host')).toContain("declare module 'orca/host'")
    expect(await read('orca-frame')).toContain('var orca: OrcaFrameApi')
    expect(await read('orca-worker')).toContain("declare module 'orca/worker'")
    expect(await read('orca-testing')).toContain("declare module 'orca/testing'")
    expect(await read('orca-services')).toContain('export interface PluginRequests {}')
    const tsconfig = JSON.parse(
      await readFile(join(dir, '.orca', 'types', 'tsconfig.json'), 'utf8')
    )
    expect(tsconfig.compilerOptions).toMatchObject({
      jsxImportSource: 'orca',
      typeRoots: ['.'],
      types: ['orca', 'orca-host', 'orca-frame', 'orca-worker', 'orca-services', 'orca-testing']
    })
    expect(await readFile(join(dir, '.orca', '.gitignore'), 'utf8')).toBe('*\n')
  })

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
