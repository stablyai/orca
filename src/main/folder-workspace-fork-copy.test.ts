import { mkdtemp, readFile, stat, writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { copyFolderWorkspaceForFork } from './folder-workspace-fork-copy'

describe('folder workspace fork copy', () => {
  const cleanupPaths: string[] = []

  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    )
  })

  it('copies local folders while respecting default and root ignore patterns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-folder-fork-'))
    cleanupPaths.push(root)
    const source = join(root, 'source')
    const destination = join(root, 'destination')

    await mkdir(join(source, 'src'), { recursive: true })
    await mkdir(join(source, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(source, 'cache'), { recursive: true })
    await writeFile(join(source, 'src', 'app.ts'), 'export const value = 1')
    await writeFile(join(source, 'node_modules', 'pkg', 'index.js'), 'generated')
    await writeFile(join(source, 'cache', 'trace.log'), 'generated')
    await writeFile(join(source, '.orcaignore'), 'cache/\n')

    await copyFolderWorkspaceForFork(
      { sourcePath: source, destinationPath: destination },
      { getSshFilesystemProvider: () => undefined }
    )

    await expect(readFile(join(destination, 'src', 'app.ts'), 'utf8')).resolves.toBe(
      'export const value = 1'
    )
    await expect(stat(join(destination, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(destination, 'cache'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
