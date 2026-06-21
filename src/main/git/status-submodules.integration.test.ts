import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { afterEach, describe, expect, it } from 'vitest'
import { getStatus } from './status'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

describe('getStatus submodules integration', () => {
  let root: string | null = null

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true })
      root = null
    }
  })

  it('reports submodule metadata from .gitmodules when porcelain status omits clean submodules', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orca-status-submodules-'))
    const libraryPath = path.join(root, 'library')
    const appPath = path.join(root, 'app')

    await git(root, ['init', '-q', libraryPath])
    await git(libraryPath, ['config', 'user.email', 'test@example.com'])
    await git(libraryPath, ['config', 'user.name', 'Test User'])
    await writeFile(path.join(libraryPath, 'README.md'), 'library\n')
    await git(libraryPath, ['add', 'README.md'])
    await git(libraryPath, ['commit', '-qm', 'init library'])

    await git(root, ['init', '-q', appPath])
    await git(appPath, ['config', 'user.email', 'test@example.com'])
    await git(appPath, ['config', 'user.name', 'Test User'])
    await writeFile(path.join(appPath, 'README.md'), 'app\n')
    await git(appPath, ['add', 'README.md'])
    await git(appPath, ['commit', '-qm', 'init app'])
    await git(appPath, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      libraryPath,
      'vendor/lib'
    ])
    await git(appPath, ['commit', '-qm', 'add submodule'])

    const status = await getStatus(appPath)

    expect(status.entries).toEqual([])
    expect(status.submodules).toEqual([
      expect.objectContaining({
        name: 'vendor/lib',
        path: 'vendor/lib',
        url: libraryPath
      })
    ])
  })
})
