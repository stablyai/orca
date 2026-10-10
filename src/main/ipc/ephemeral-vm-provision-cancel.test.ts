import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const handlers = new Map<string, (_event: unknown, args: never) => unknown>()
const { getPathMock, handleMock, resolveProvisionedRootSourceMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(),
  handleMock: vi.fn(),
  resolveProvisionedRootSourceMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: getPathMock },
  ipcMain: { handle: handleMock, removeHandler: vi.fn() }
}))

vi.mock('../ephemeral-vm-provisioned-root-source', () => ({
  resolveProvisionedRootSource: resolveProvisionedRootSourceMock
}))

import { registerEphemeralVmHandlers } from './ephemeral-vm'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

it('cancels source resolution before a provisioned-root recipe creates resources', async () => {
  const userDataPath = makeTempDir('orca-vm-cancel-user-data-')
  const repoPath = makeTempDir('orca-vm-cancel-repo-')
  const createMarker = join(repoPath, 'create-ran')
  getPathMock.mockReturnValue(userDataPath)
  handleMock.mockImplementation((channel: string, handler: never) => handlers.set(channel, handler))
  writeRecipe(repoPath, createMarker)
  resolveProvisionedRootSourceMock.mockImplementation(
    (_store, _repo, _ref, signal: AbortSignal | undefined) =>
      new Promise((resolve) =>
        signal?.addEventListener('abort', () => resolve(null), { once: true })
      )
  )
  registerEphemeralVmHandlers(makeStore(repoPath) as never)

  const provision = handlers.get('ephemeralVm:provision')?.(null, {
    repoId: 'repo-1',
    recipeId: 'cloud-sandbox',
    provisionId: 'provision-source-ref'
  } as never) as Promise<{ ok: boolean; error?: string }>
  await vi.waitFor(() => expect(resolveProvisionedRootSourceMock).toHaveBeenCalledOnce())
  const cancelled = await handlers.get('ephemeralVm:cancelProvision')?.(null, {
    provisionId: 'provision-source-ref'
  } as never)
  const result = await provision

  expect(cancelled).toEqual({ cancelled: true })
  expect(result).toEqual({ ok: false, error: 'Provisioning cancelled.', stdout: '', stderr: '' })
  expect(existsSync(createMarker)).toBe(false)
})

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeStore(repoPath: string) {
  const repo = { id: 'repo-1', path: repoPath, displayName: 'Repo', addedAt: 0 }
  return {
    getRepo: vi.fn((id: string) => (id === repo.id ? repo : null)),
    getRepos: vi.fn(() => [repo]),
    getSettings: vi.fn(() => ({ activeRuntimeEnvironmentId: null }))
  }
}

function writeRecipe(repoPath: string, createMarker: string): void {
  writeFileSync(
    join(repoPath, 'orca.yaml'),
    [
      'environmentRecipes:',
      '  - id: cloud-sandbox',
      '    name: Cloud Sandbox',
      '    checkoutMode: provisioned-root',
      `    create: ${JSON.stringify(`"${process.execPath}" -e "require('node:fs').writeFileSync('${createMarker}','x')"`)}`,
      '    destroy: none'
    ].join('\n')
  )
}
