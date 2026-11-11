import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeFileAccess } from './file-access'
import { createRuntimeFileHost } from './runtime-file-host.test-fixture'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('files.statMany (statManyRuntimeFiles)', () => {
  it('stats a batch in order: files, directories and absent paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stat-many-'))
    dirs.push(root)
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'a.ts'), 'hello')
    const { host, store } = createRuntimeFileHost({ path: root })
    // The local provider authorizes paths against the registered repositories.
    Object.assign(store, {
      getRepos: () => [{ id: 'repo-1', path: root, displayName: 'repo', kind: 'git' }]
    })
    const access = new RuntimeFileAccess(host)
    const { entries } = await access.statManyRuntimeFiles('wt-1', [
      'src/a.ts',
      'src',
      'missing.txt'
    ])
    expect(entries[0]).toMatchObject({ size: 5, type: 'file', mtime: expect.any(Number) })
    expect(entries[1]).toMatchObject({ type: 'directory' })
    expect(entries[2]).toBeNull()
  })

  it('refuses batches over the limit', async () => {
    const { host } = createRuntimeFileHost({ path: '/repo' })
    const access = new RuntimeFileAccess(host)
    await expect(
      access.statManyRuntimeFiles(
        'wt-1',
        Array.from({ length: 2001 }, (_, i) => `f${i}`)
      )
    ).rejects.toThrow('Invalid stat batch')
  })
})
