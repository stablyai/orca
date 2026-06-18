import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { diffFolderWorkspaceFork } from './folder-workspace-fork-diff'
import type { FileReadResult, FileStat, IFilesystemProvider } from './providers/types'

describe('folder workspace fork diff', () => {
  it('diffs local folder forks while respecting folder copy ignores', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-folder-diff-'))
    const parent = join(root, 'parent')
    const child = join(root, 'child')
    try {
      await mkdir(join(parent, 'src'), { recursive: true })
      await mkdir(join(parent, 'tmp'), { recursive: true })
      await mkdir(join(parent, 'node_modules', 'pkg'), { recursive: true })
      await mkdir(join(child, 'src'), { recursive: true })
      await mkdir(join(child, 'tmp'), { recursive: true })
      await mkdir(join(child, 'node_modules', 'pkg'), { recursive: true })
      await writeFile(join(parent, '.orcaignore'), 'tmp/\n')
      await writeFile(join(child, '.orcaignore'), 'tmp/\n')
      await writeFile(join(parent, 'src', 'app.ts'), 'old\n')
      await writeFile(join(child, 'src', 'app.ts'), 'new\n')
      await writeFile(join(parent, 'src', 'removed.ts'), 'removed\n')
      await writeFile(join(child, 'src', 'added.ts'), 'added\n')
      await writeFile(join(parent, 'tmp', 'trace.log'), 'old ignored\n')
      await writeFile(join(child, 'tmp', 'trace.log'), 'new ignored\n')
      await writeFile(join(parent, 'node_modules', 'pkg', 'index.js'), 'old generated\n')
      await writeFile(join(child, 'node_modules', 'pkg', 'index.js'), 'new generated\n')

      const result = await diffFolderWorkspaceFork(
        { parentPath: parent, childPath: child },
        { getSshFilesystemProvider: () => undefined }
      )

      expect(result.diff).toContain('diff --git a/src/app.ts b/src/app.ts')
      expect(result.diff).toContain('-old')
      expect(result.diff).toContain('+new')
      expect(result.diff).toContain('diff --git a/src/added.ts b/src/added.ts')
      expect(result.diff).toContain('+++ b/src/added.ts')
      expect(result.diff).toContain('diff --git a/src/removed.ts b/src/removed.ts')
      expect(result.diff).toContain('--- a/src/removed.ts')
      expect(result.diff).not.toContain('tmp/trace.log')
      expect(result.diff).not.toContain('node_modules')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('diffs remote folder forks through the filesystem provider', async () => {
    const files = new Map<string, string>([
      ['/remote/parent/.orcaignore', 'tmp/\n'],
      ['/remote/parent/src/app.ts', 'old\n'],
      ['/remote/child/src/app.ts', 'new\n'],
      ['/remote/child/src/added.ts', 'added\n'],
      ['/remote/parent/tmp/trace.log', 'old ignored\n'],
      ['/remote/child/tmp/trace.log', 'new ignored\n']
    ])
    const provider = {
      listFiles: vi.fn(async (rootPath: string) =>
        [...files.keys()]
          .filter((filePath) => filePath.startsWith(`${rootPath}/`))
          .map((filePath) => filePath.slice(rootPath.length + 1))
      ),
      stat: vi.fn(async (filePath: string): Promise<FileStat> => {
        const content = files.get(filePath)
        if (content === undefined) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        return { size: Buffer.byteLength(content), type: 'file', mtime: 1 }
      }),
      readFile: vi.fn(async (filePath: string): Promise<FileReadResult> => {
        const content = files.get(filePath)
        if (content === undefined) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        return { content, isBinary: false }
      })
    } as Partial<IFilesystemProvider> as IFilesystemProvider

    const result = await diffFolderWorkspaceFork(
      {
        parentPath: '/remote/parent',
        childPath: '/remote/child',
        connectionId: 'ssh-1'
      },
      { getSshFilesystemProvider: () => provider }
    )

    expect(result.diff).toContain('diff --git a/src/app.ts b/src/app.ts')
    expect(result.diff).toContain('+new')
    expect(result.diff).toContain('diff --git a/src/added.ts b/src/added.ts')
    expect(result.diff).not.toContain('tmp/trace.log')
    expect(provider.listFiles).toHaveBeenCalledWith('/remote/parent')
    expect(provider.listFiles).toHaveBeenCalledWith('/remote/child')
  })
})
