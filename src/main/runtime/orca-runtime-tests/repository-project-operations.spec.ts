import '../../git/command-runner/git-spawn'
import { describe, expect, it } from 'vitest'
import { realpath, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import '../../project-groups/folder-workspace-path-status'
import './runtime-test-module-registration.spec'
import '../../../shared/repo-badge-color'
import 'node:events'
import { OrcaRuntimeService } from '../orca-runtime'
import 'node:child_process'
import '../orca-runtime-test-mocks/setup.spec'
import { join, win32 } from 'node:path'
import 'node:fs'
import '../../../shared/project-host-setup-projection'
import { tmpdir } from 'node:os'
import { store } from './orca-runtime-test-fixtures.spec'

// Clone and create register resolved paths (macOS tmpdir is a /var symlink).
async function mkdtempReal(prefix: string): Promise<string> {
  return realpath(await mkdtemp(prefix))
}

describe('OrcaRuntimeService', () => {
  it('browses runtime server directories before projects are added', async () => {
    const tempRoot = await mkdtempReal(join(tmpdir(), 'orca-runtime-browse-'))
    try {
      await mkdir(join(tempRoot, 'zeta'))
      await mkdir(join(tempRoot, 'alpha'))
      await writeFile(join(tempRoot, 'readme.md'), '# Readme\n')
      const runtime = new OrcaRuntimeService(store)

      const result = await runtime.browseServerDir(tempRoot)

      expect(result.resolvedPath).toBe(tempRoot)
      expect(result.pathFlavor).toBe(process.platform === 'win32' ? 'win32' : 'posix')
      expect(result.entries).toEqual([
        { name: 'alpha', isDirectory: true, isSymlink: false },
        { name: 'zeta', isDirectory: true, isSymlink: false },
        { name: 'readme.md', isDirectory: false, isSymlink: false }
      ])
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'win32')('lists drive roots for a server-root browse', async () => {
    const runtime = new OrcaRuntimeService(store)

    const result = await runtime.browseServerDir('/')

    expect(result.resolvedPath).toBe('/')
    expect(result.pathFlavor).toBe('win32')
    expect(result.entries).toContainEqual({
      name: win32.parse(tmpdir()).root.toUpperCase(),
      isDirectory: true,
      isSymlink: false
    })
  })
})
