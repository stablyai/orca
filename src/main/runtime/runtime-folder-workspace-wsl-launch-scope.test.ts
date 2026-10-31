import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const statMock = vi.hoisted(() => vi.fn<(path: string) => Promise<{ isDirectory(): boolean }>>())
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  stat: statMock
}))

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  createFolderWorkspaceRuntimeStore,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  TEST_FOLDER_WORKSPACE_KEY
} = await import('./orca-runtime-test-fixtures.spec')
const { blockedWslDistroForPath } = await import('../wsl/wsl-unc-access-gate')
const { isWslUserActFor } = await import('../wsl/wsl-user-act-scope')
const { wslDistroHoldMessage } = await import('../../shared/wsl-distro-stopped-hold')
const { LOCAL_EXECUTION_HOST_ID } = await import('../../shared/execution-host')

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

  it('checks the folder as the user act for a resume the user asked for', async () => {
    await makeRuntime().resumeAgentSessionInWorkspace(TEST_FOLDER_WORKSPACE_KEY, {
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'provider-session-1' },
      captureHostId: LOCAL_EXECUTION_HOST_ID,
      mutationId: 'resume-1'
    })
    expect(statsInUserAct[0]).toBe(true)
  })

  it('holds background work with Start, naming the distro, without touching the folder', async () => {
    await expect(
      makeRuntime().resolveTerminalWorkspaceLaunchScope(`id:${TEST_FOLDER_WORKSPACE_KEY}`)
    ).rejects.toThrow(wslDistroHoldMessage('Ubuntu', 'stopped'))
    expect(statMock).not.toHaveBeenCalled()
  })
})
