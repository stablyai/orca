import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../config/scripts/vitest-host-ports-setup'
import type { RuntimeStore } from '../runtime-store-contract'
import { PATH_ACCESS_DENIED_MESSAGE } from '../../ipc/filesystem/filesystem-auth'
import { resolveRuntimeAuthorizedPath } from './chat-scratch-file-root'

// The runtime authorizes file paths through this WSL-aware realpath; stub it to identity so the
// test exercises the allowed-roots decision, not WSL drive-mount translation.
vi.mock('../../wsl/wsl-unc-drive-fs-path', () => ({
  realpathAcrossWslDriveMount: async (path: string) => path,
  windowsFsPath: (path: string) => path
}))

function runtimeStore(settings: {
  floatingTerminalCwd?: string
  floatingTerminalTrustedCwds?: string[]
  workspaceDir: string
}): RuntimeStore {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization reads only these catalog/settings methods; no repos, groups, or folders are registered in this fixture.
  return {
    getRepos: () => [],
    getProjectGroups: () => [],
    getFolderWorkspaces: () => [],
    getSettings: () => settings
  } as unknown as RuntimeStore
}

describe('resolveRuntimeAuthorizedPath (floating workspace)', () => {
  let tempRoot: string
  let floatingCwd: string
  let outsideDir: string

  beforeEach(async () => {
    installFakeAppEnvironment()
    tempRoot = await mkdtemp(join(tmpdir(), 'orca-float-cwd-'))
    floatingCwd = join(tempRoot, 'studio')
    outsideDir = join(tempRoot, 'elsewhere')
    await mkdir(floatingCwd, { recursive: true })
    await mkdir(outsideDir, { recursive: true })
    await writeFile(join(floatingCwd, 'index.html'), '<html></html>')
    await writeFile(join(outsideDir, 'index.html'), '<html></html>')
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('authorizes a bare filename inside the configured floating terminal cwd', async () => {
    const store = runtimeStore({
      floatingTerminalCwd: floatingCwd,
      floatingTerminalTrustedCwds: [floatingCwd],
      workspaceDir: outsideDir
    })
    // Before the fix this threw PATH_ACCESS_DENIED_MESSAGE because the floating cwd was never an
    // allowed root on the runtime path (unlike the desktop, which adds its floating workspace).
    await expect(resolveRuntimeAuthorizedPath(join(floatingCwd, 'index.html'), store)).resolves.toBe(
      join(floatingCwd, 'index.html')
    )
  })

  it('still denies a file outside the floating cwd and every registered root', async () => {
    const store = runtimeStore({
      floatingTerminalCwd: floatingCwd,
      floatingTerminalTrustedCwds: [floatingCwd],
      workspaceDir: join(tempRoot, 'unused-workspace')
    })
    await expect(resolveRuntimeAuthorizedPath(join(outsideDir, 'index.html'), store)).rejects.toThrow(
      PATH_ACCESS_DENIED_MESSAGE
    )
  })

  it('authorizes the floating cwd even when it is not in the trusted list (terminal may run there)', async () => {
    const store = runtimeStore({
      floatingTerminalCwd: floatingCwd,
      floatingTerminalTrustedCwds: [],
      workspaceDir: join(tempRoot, 'unused-workspace')
    })
    await expect(resolveRuntimeAuthorizedPath(join(floatingCwd, 'index.html'), store)).resolves.toBe(
      join(floatingCwd, 'index.html')
    )
  })
})