import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import {
  hasGitMarker,
  isRealLocalDirectory,
  readLocalDirectory,
  scanNestedRepos
} from './nested-repo-discovery'

let tempDirs: string[] = []

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-nested-repos-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

it.skipIf(process.platform === 'win32')(
  'skips a listed folder that became a symlink before it was probed',
  async () => {
    const root = await tempRoot()
    const external = await tempRoot()
    await mkdir(join(external, 'outside-repo', '.git'), { recursive: true })
    await mkdir(join(root, 'swapped'))

    const result = await scanNestedRepos({
      path: root,
      filesystem: {
        readDirectory: async (dirPath: string) => {
          const entries = await readLocalDirectory(dirPath)
          if (dirPath === root) {
            // Swap after listing so the entry still reads as a plain directory.
            await rm(join(root, 'swapped'), { recursive: true })
            await symlink(join(external, 'outside-repo'), join(root, 'swapped'), 'dir')
          }
          return entries
        },
        isRealDirectory: isRealLocalDirectory,
        joinPath: join,
        basename,
        hasGitMarker,
        isSelectedPathGitRepo: () => false
      }
    })

    expect(result.repos).toEqual([])
  }
)
