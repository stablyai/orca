import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import type { RuntimeStore } from '../construction/runtime-store-contract'
import { invalidateAuthorizedRootsCache } from '../../ipc/worktrees/removal/registered-worktree-roots-cache'
import { resolveRuntimeAuthorizedPath } from './chat-scratch-file-root'

let base: string
let home: string
let project: string

function storeWithFloatingCwd(cwd: string, trusted: string[]): RuntimeStore {
  const settings = {
    workspaceDir: '',
    nestWorkspaces: false,
    floatingTerminalCwd: cwd,
    floatingTerminalTrustedCwds: trusted
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization reads only these members.
  return {
    getRepos: () => [],
    getProjectGroups: () => [],
    getFolderWorkspaces: () => [],
    getSettings: () => settings
  } as unknown as RuntimeStore
}

beforeEach(async () => {
  invalidateAuthorizedRootsCache()
  base = await realpath(await mkdtemp(join(tmpdir(), 'orca-runtime-floating-root-')))
  home = join(base, 'home')
  project = join(base, 'project')
  await mkdir(home)
  await mkdir(project)
  await writeFile(join(home, 'secret.txt'), 'x')
  await writeFile(join(project, 'index.html'), 'x')
  installFakeAppEnvironment({
    getPath: (name) => (name === 'home' ? home : join(base, 'user-data'))
  })
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('runtime file authorization for the floating workspace', () => {
  it('authorizes files in a trusted floating cwd', async () => {
    const store = storeWithFloatingCwd(project, [project])
    await expect(resolveRuntimeAuthorizedPath(join(project, 'index.html'), store)).resolves.toBe(
      join(project, 'index.html')
    )
  })

  // #36950 as reported: `orca serve` with the floating cwd at a trusted project under home.
  it('authorizes a file in a trusted cwd spelled from home', async () => {
    const app = join(home, 'projects', 'my-app')
    await mkdir(app, { recursive: true })
    await writeFile(join(app, 'index.html'), 'x')
    const store = storeWithFloatingCwd('~/projects/my-app', [app])
    await expect(resolveRuntimeAuthorizedPath(join(app, 'index.html'), store)).resolves.toBe(
      join(app, 'index.html')
    )
  })

  it('does not authorize an untrusted floating cwd or the home default', async () => {
    await expect(
      resolveRuntimeAuthorizedPath(join(project, 'index.html'), storeWithFloatingCwd(project, []))
    ).rejects.toThrow(/outside allowed directories/)
    for (const cwd of ['', '~']) {
      await expect(
        resolveRuntimeAuthorizedPath(join(home, 'secret.txt'), storeWithFloatingCwd(cwd, []))
      ).rejects.toThrow(/outside allowed directories/)
    }
  })

  it('authorizes an explicitly trusted home, but never a folder above it', async () => {
    for (const cwd of [home, '~']) {
      await expect(
        resolveRuntimeAuthorizedPath(join(home, 'secret.txt'), storeWithFloatingCwd(cwd, [home]))
      ).resolves.toBe(join(home, 'secret.txt'))
    }
    await expect(
      resolveRuntimeAuthorizedPath(join(home, 'secret.txt'), storeWithFloatingCwd(base, [base]))
    ).rejects.toThrow(/outside allowed directories/)
  })

  it('matches a trusted ~ when home itself is reached through a link', async () => {
    const linkedHome = join(base, 'linked-home')
    await symlink(home, linkedHome, process.platform === 'win32' ? 'junction' : 'dir')
    installFakeAppEnvironment({
      getPath: (name) => (name === 'home' ? linkedHome : join(base, 'user-data'))
    })
    const store = storeWithFloatingCwd('~', [home])
    await expect(resolveRuntimeAuthorizedPath(join(home, 'secret.txt'), store)).resolves.toBe(
      join(home, 'secret.txt')
    )
  })

  // Byte-exact names (ext4) let an NFC root be swapped for a link to a distinct NFD-named folder.
  it.skipIf(process.platform !== 'linux')(
    'does not follow a trusted cwd swapped for a link to a Unicode-equivalent folder',
    async () => {
      const approved = join(base, 'caf\u00e9')
      const lookalike = join(base, 'cafe\u0301')
      await mkdir(approved)
      await mkdir(lookalike)
      await writeFile(join(lookalike, 'index.html'), 'x')
      const store = storeWithFloatingCwd(approved, [approved])
      await rm(approved, { recursive: true })
      await symlink(lookalike, approved, 'dir')
      await expect(
        resolveRuntimeAuthorizedPath(join(lookalike, 'index.html'), store)
      ).rejects.toThrow(/outside allowed directories/)
    }
  )

  it('does not follow a trusted cwd that was replaced by a link elsewhere', async () => {
    const elsewhere = join(base, 'elsewhere')
    await rename(project, elsewhere)
    await symlink(elsewhere, project, process.platform === 'win32' ? 'junction' : 'dir')
    const store = storeWithFloatingCwd(project, [project])
    await expect(resolveRuntimeAuthorizedPath(join(project, 'index.html'), store)).rejects.toThrow(
      /outside allowed directories/
    )
  })
})
