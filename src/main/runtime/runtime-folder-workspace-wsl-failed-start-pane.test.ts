import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const statMock = vi.hoisted(() => vi.fn<(path: string) => Promise<{ isDirectory(): boolean }>>())
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  stat: statMock
}))
vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

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

const PARENT = '\\\\wsl.localhost\\Ubuntu\\home\\me'
const FOLDER = `${PARENT}\\notes`
const hostPlatform = process.platform
const statsInUserAct: boolean[] = []

function failedStart(wslUserAct: boolean): Promise<unknown> {
  const runtime = new OrcaRuntimeService(
    createFolderWorkspaceRuntimeStore(
      makeFolderWorkspace({ folderPath: FOLDER }),
      makeFolderProjectGroup({ parentPath: PARENT })
    )
  )
  return runtime
    .createTerminal(`id:${TEST_FOLDER_WORKSPACE_KEY}`, {
      keepPaneOnStartFailure: true,
      startFailure: new Error('agent runtime needs repair'),
      ...(wslUserAct ? { wslUserAct: true as const } : {})
    })
    .catch(() => undefined)
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
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
  vi.restoreAllMocks()
})

describe('the pane a failed start keeps, in a folder workspace on a stopped WSL distro (E9)', () => {
  it("checks the folder as the user's act when the user started it", async () => {
    await failedStart(true)
    expect(statsInUserAct).toEqual([true])
  })

  it('never touches the folder for a background start', async () => {
    await failedStart(false)
    expect(statMock).not.toHaveBeenCalled()
  })
})
