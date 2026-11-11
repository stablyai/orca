import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const statMock = vi.hoisted(() => vi.fn<(path: string) => Promise<{ isDirectory(): boolean }>>())
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  stat: statMock
}))

const repositoryReadMock = vi.hoisted(() =>
  vi.fn(async () => ({
    entries: [],
    conflictOperation: 'unknown',
    repositoryStatuses: [{ path: '', kind: 'repository' }]
  }))
)
vi.mock('../../../git/source-control/repository-status', () => ({
  getRepositoryStatuses: repositoryReadMock
}))

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
await import('../../orca-runtime-tests/runtime-test-module-registration.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime')
await import('../../orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const {
  createFolderWorkspaceRuntimeStore,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  TEST_FOLDER_WORKSPACE_KEY
} = await import('../../orca-runtime-tests/orca-runtime-test-fixtures.spec')
const { blockedWslDistroForPath } = await import('../../../wsl/filesystem/wsl-unc-access-gate')
const { isWslUserActFor } = await import('../../../wsl/discovery/wsl-user-act-scope')
const { wslDistroHoldMessage } = await import('../../../../shared/wsl-distro-stopped-hold')

const PARENT = '\\\\wsl.localhost\\Ubuntu\\home\\me'
const FOLDER = `${PARENT}\\notes`
const hostPlatform = process.platform
const statsInUserAct: boolean[] = []

function makeRuntime(): InstanceType<typeof OrcaRuntimeService> {
  return new OrcaRuntimeService(
    createFolderWorkspaceRuntimeStore(
      makeFolderWorkspace({ folderPath: FOLDER }),
      makeFolderProjectGroup({ parentPath: PARENT })
    )
  )
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  statsInUserAct.length = 0
  statMock.mockReset()
  statMock.mockImplementation(async () => {
    statsInUserAct.push(isWslUserActFor('Ubuntu'))
    return { isDirectory: () => true }
  })
  // Stopped, as the real gate reads it: only the user's act on the distro passes.
  vi.mocked(blockedWslDistroForPath).mockImplementation(async () =>
    isWslUserActFor('Ubuntu') ? null : { distro: 'Ubuntu', state: 'stopped' }
  )
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
  vi.mocked(blockedWslDistroForPath).mockReset()
  vi.mocked(blockedWslDistroForPath).mockResolvedValue(null)
})

describe('a runtime start in a folder workspace on a stopped WSL distro (E9)', () => {
  it("checks the folder as the user's act, which may start the distro", async () => {
    await expect(
      makeRuntime().resolveTerminalWorkspaceLaunchScope(
        `id:${TEST_FOLDER_WORKSPACE_KEY}`,
        undefined,
        {
          wslUserAct: true
        }
      )
    ).resolves.toMatchObject({ id: TEST_FOLDER_WORKSPACE_KEY, path: FOLDER })
    expect(statsInUserAct).toEqual([true])
  })

  it('holds background work with Start, naming the distro, without touching the folder', async () => {
    await expect(
      makeRuntime().resolveTerminalWorkspaceLaunchScope(`id:${TEST_FOLDER_WORKSPACE_KEY}`)
    ).rejects.toThrow(wslDistroHoldMessage('Ubuntu', 'stopped'))
    expect(statMock).not.toHaveBeenCalled()
  })
})

it('resolves read-only folder Git authority before physical folder checks', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
  statMock.mockRejectedValue(
    Object.assign(new Error('raw namespace cannot be opened'), { code: 'EPERM' })
  )
  const runtime = makeRuntime()
  await expect(
    runtime.getRuntimeGitStatus(`id:${TEST_FOLDER_WORKSPACE_KEY}`, {
      repositoryPaths: [''],
      repositoryIntent: 'probe'
    })
  ).resolves.toMatchObject({ repositoryStatuses: [{ path: '', kind: 'repository' }] })
  expect(statMock).not.toHaveBeenCalled()
  expect(repositoryReadMock).toHaveBeenCalledWith(
    FOLDER,
    expect.objectContaining({ repositoryPaths: [''], repositoryIntent: 'probe' }),
    expect.objectContaining({ admissionTier: 'background' })
  )
})

it.each([
  { executionHostId: 'runtime:other', connectionId: null },
  { executionHostId: 'runtime:other', connectionId: 'nested-ssh' },
  { executionHostId: 'ssh:other', connectionId: 'other' }
] as const)(
  'refuses unserved folder Git authority %j before reading its same-spelled local path',
  async (host) => {
    Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
    repositoryReadMock.mockClear()
    const runtime = new OrcaRuntimeService(
      createFolderWorkspaceRuntimeStore(
        makeFolderWorkspace({ folderPath: FOLDER, ...host }),
        makeFolderProjectGroup({ parentPath: PARENT, ...host })
      )
    )
    await expect(
      runtime.getRuntimeGitStatus(`id:${TEST_FOLDER_WORKSPACE_KEY}`, {
        repositoryPaths: [''],
        repositoryIntent: 'status'
      })
    ).rejects.toBeInstanceOf(Error)
    expect(repositoryReadMock).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
  }
)
