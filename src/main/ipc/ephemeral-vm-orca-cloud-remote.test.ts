import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { registerEphemeralVmRecipeStepProvider } from '../../shared/ephemeral-vm-recipe-step-providers'
import { ORCA_CLOUD_RECIPE } from '../hosted-sandbox/hosted-sandbox-recipe'

const handlers = new Map<string, (_event: unknown, args: never) => unknown>()
const { getPathMock, handleMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(),
  handleMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: getPathMock },
  ipcMain: { handle: handleMock, removeHandler: vi.fn() }
}))

vi.mock('../hosted-sandbox/hosted-sandbox-install', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withProviderRecipes: async () => [ORCA_CLOUD_RECIPE]
}))

import { registerEphemeralVmHandlers } from './ephemeral-vm'

const tempDirs: string[] = []
const unregister: (() => void)[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  for (const off of unregister.splice(0)) {
    off()
  }
  vi.clearAllMocks()
})

function setup(remote: string | null) {
  const userDataPath = makeTempDir('orca-cloud-remote-user-data-')
  const repoPath = makeTempDir('orca-cloud-remote-repo-')
  execFileSync('git', ['init', '-q'], { cwd: repoPath })
  if (remote) {
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repoPath })
  }
  getPathMock.mockReturnValue(userDataPath)
  handleMock.mockImplementation((channel: string, handler: never) => handlers.set(channel, handler))
  const step = vi.fn(async () => ({
    stdout: '',
    stderr: 'stopped here\n',
    exitCode: 1,
    signal: null
  }))
  unregister.push(registerEphemeralVmRecipeStepProvider('orca-cloud', step))
  const repo = { id: 'repo-1', path: repoPath, displayName: 'Repo', addedAt: 0 }
  registerEphemeralVmHandlers({
    getRepo: vi.fn((id: string) => (id === repo.id ? repo : null)),
    getRepos: vi.fn(() => [repo]),
    getSettings: vi.fn(() => ({ activeRuntimeEnvironmentId: null }))
  } as never)
  const provision = (extra: Record<string, unknown> = {}) =>
    handlers.get('ephemeralVm:provision')?.(null, {
      repoId: 'repo-1',
      recipeId: ORCA_CLOUD_RECIPE.id,
      ...extra
    } as never) as Promise<{ ok: boolean; errorCode?: string }>
  return { step, provision }
}

it('refuses a repository with no GitHub remote before Orca Cloud is asked for a sandbox', async () => {
  const { step, provision } = setup(null)
  const result = await provision()
  expect(result).toMatchObject({ ok: false, errorCode: 'cloudNoGithubRemote' })
  expect(step).not.toHaveBeenCalled()
})

it('refuses a remote GitHub does not host, too', async () => {
  const { step, provision } = setup('https://gitlab.com/acme/web.git')
  expect(await provision()).toMatchObject({ ok: false, errorCode: 'cloudNoGithubRemote' })
  expect(step).not.toHaveBeenCalled()
})

it('starts the sandbox when the user chose to start empty, or the repo is on GitHub', async () => {
  const empty = setup(null)
  await empty.provision({ startEmpty: true })
  expect(empty.step).toHaveBeenCalledOnce()

  const github = setup('git@github.com:acme/web.git')
  await github.provision()
  expect(github.step).toHaveBeenCalledOnce()
})

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
