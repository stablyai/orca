import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { rgPath } from '@vscode/ripgrep-universal'
import { configureRelayBundledRipgrep } from './relay-bundled-ripgrep'
import { listFilesWithRg } from './fs-handler-list-files'

let root: string | undefined

afterEach(async () => {
  configureRelayBundledRipgrep(undefined)
  vi.unstubAllEnvs()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it('ignores user rg configuration when listing files', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-rg-config-'))
  configureRelayBundledRipgrep(rgPath)
  const config = join(root, 'config')
  await writeFile(config, '--glob\n!*.ts\n')
  await writeFile(join(root, 'visible.ts'), '')
  vi.stubEnv('RIPGREP_CONFIG_PATH', config)

  expect(await listFilesWithRg(root)).toContain('visible.ts')
  expect(await listFilesWithRg(root, [], { maxResults: 10 })).toContain('visible.ts')
})

it.skipIf(process.platform === 'win32')(
  'preserves newline, carriage return and Unicode filenames',
  async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-rg-filenames-'))
    configureRelayBundledRipgrep(rgPath)
    const names = ['first\nsecond.ts', 'trailing\r', 'résumé-😀.ts', 'spaces .ts ']
    const fixtureRoot = root
    await Promise.all(names.map((name) => writeFile(join(fixtureRoot, name), '')))

    expect((await listFilesWithRg(root)).sort()).toEqual([...names].sort())
    expect((await listFilesWithRg(root, [], { maxResults: 10 })).sort()).toEqual([...names].sort())
    expect(await listFilesWithRg(root, [], { searchQuery: 'second', maxResults: 1 })).toEqual([
      'first\nsecond.ts'
    ])
  }
)

it.skipIf(process.platform !== 'linux')(
  'rejects real non-UTF8 filenames instead of fabricating paths',
  async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-rg-invalid-name-'))
    configureRelayBundledRipgrep(rgPath)
    const invalidPath = Buffer.concat([Buffer.from(join(root, 'bad-')), Buffer.from([0xff])])
    await writeFile(invalidPath, '')
    await expect(listFilesWithRg(root)).rejects.toThrow('not valid UTF-8')
  }
)
