import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import { listEphemeralVmRuntimes } from '../shared/ephemeral-vm-runtime-store'
import { connectRuntimeOwnedSshTarget } from './ephemeral-vm-runtime-ssh'
import { resolveProvisionedRootSource } from './ephemeral-vm-provisioned-root-source'
import { adoptProvisionedRootSshCheckout } from './provisioned-root-ssh-adoption'
import { addRemoteRepoFromPath } from './ipc/repos/remote-repo-registration'
import { alignRepoWithRequestedProject } from './ipc/repos/project-host-setup-handlers'
import {
  cleanupRecipeRuntimesForWorkspace,
  createProvisionedRootRecipeWorkspace
} from './ephemeral-vm-recipe-workspace-create'

vi.mock('./ephemeral-vm-runtime-ssh', () => ({
  connectRuntimeOwnedSshTarget: vi.fn(),
  removeRuntimeOwnedSshTarget: vi.fn(async () => undefined)
}))
vi.mock('./ephemeral-vm-provisioned-root-source', () => ({
  resolveProvisionedRootSource: vi.fn()
}))
vi.mock('./provisioned-root-ssh-adoption', () => ({
  adoptProvisionedRootSshCheckout: vi.fn()
}))
vi.mock('./ipc/repos/remote-repo-registration', () => ({
  addRemoteRepoFromPath: vi.fn()
}))
vi.mock('./ipc/repos/project-host-setup-handlers', () => ({
  alignRepoWithRequestedProject: vi.fn()
}))
vi.mock('./ipc/registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: vi.fn()
}))

const connectMock = vi.mocked(connectRuntimeOwnedSshTarget)
const addRemoteRepoMock = vi.mocked(addRemoteRepoFromPath)
const alignRepoMock = vi.mocked(alignRepoWithRequestedProject)
const sourceMock = vi.mocked(resolveProvisionedRootSource)
const adoptMock = vi.mocked(adoptProvisionedRootSshCheckout)

const tempDirs: string[] = []

afterEach(() => {
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  sourceMock.mockResolvedValue({
    ref: 'origin/main',
    head: 'abc123',
    remoteUrl: 'https://example.com/repo.git'
  })
  addRemoteRepoMock.mockImplementation(async (_store, registration) => ({
    repo: {
      id: 'repo-ssh-1',
      path: registration.remotePath,
      connectionId: registration.connectionId,
      kind: 'git'
    } as unknown as Repo,
    alreadyExisted: false
  }))
  alignRepoMock.mockImplementation(
    (_store, repo) => ({ repo }) as ReturnType<typeof alignRepoWithRequestedProject>
  )
})

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function nodeCommand(scriptPath: string): string {
  return `"${process.execPath}" "${scriptPath}"`
}

function writeRecipeRepo(options: { checkoutMode?: string; connectionType?: 'ssh' | 'pairing' }): {
  repoDir: string
  envPath: string
  destroyMarkerPath: string
} {
  const repoDir = makeDir('recipe-repo-')
  const envPath = join(repoDir, 'create-env.json')
  const destroyMarkerPath = join(repoDir, 'destroyed')
  const createPath = join(repoDir, 'create.cjs')
  const destroyPath = join(repoDir, 'destroy.cjs')
  const result =
    options.connectionType === 'pairing'
      ? {
          schemaVersion: 1,
          pairingCode: 'orca://pair?code=x',
          projectRoot: '/home/dev/repo'
        }
      : {
          schemaVersion: 2,
          checkoutMode: 'provisioned-root',
          connection: {
            type: 'ssh',
            projectRoot: '/home/dev/repo',
            target: { label: 'vm', host: 'vm-host', port: 22, username: 'dev' }
          }
        }
  writeFileSync(
    createPath,
    [
      `require('node:fs').writeFileSync(${JSON.stringify(envPath)}, JSON.stringify(process.env))`,
      `console.log(JSON.stringify(${JSON.stringify(result)}))`
    ].join('\n')
  )
  writeFileSync(
    destroyPath,
    `require('node:fs').writeFileSync(${JSON.stringify(destroyMarkerPath)}, 'x')`
  )
  writeFileSync(
    join(repoDir, 'orca.yaml'),
    [
      'environmentRecipes:',
      '  - id: devbox',
      '    name: Devbox',
      ...(options.checkoutMode ? [`    checkoutMode: ${options.checkoutMode}`] : []),
      `    create: '${nodeCommand(createPath)}'`,
      `    destroy: '${nodeCommand(destroyPath)}'`
    ].join('\n')
  )
  return { repoDir, envPath, destroyMarkerPath }
}

function makeRepo(repoDir: string): Repo {
  return {
    id: 'repo-1',
    path: repoDir,
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 1,
    kind: 'git'
  } as Repo
}

function makeDeps(repo: Repo): {
  userDataPath: string
  store: Store
  getApprovedPluginRecipes: () => Promise<never[]>
  isRepoCurrent: () => boolean
} {
  return {
    userDataPath: makeDir('recipe-user-data-'),
    store: { getRepo: (id: string) => (id === repo.id ? repo : undefined) } as unknown as Store,
    getApprovedPluginRecipes: async () => [],
    isRepoCurrent: () => true
  }
}

function makeArgs(repo: Repo) {
  return {
    repo,
    recipeId: 'devbox',
    projectId: 'github:acme/repo',
    branchName: 'feat-x',
    request: { name: 'feat-x', displayName: 'feat-x' }
  }
}

describe('createProvisionedRootRecipeWorkspace', () => {
  it('provisions, registers the remote root, and adopts the checkout', async () => {
    const { repoDir, envPath } = writeRecipeRepo({ checkoutMode: 'provisioned-root' })
    const repo = makeRepo(repoDir)
    const deps = makeDeps(repo)
    const args = makeArgs(repo)
    connectMock.mockResolvedValue({
      targetId: 'target-1',
      target: { id: 'target-1' }
    } as unknown as Awaited<ReturnType<typeof connectRuntimeOwnedSshTarget>>)
    const adopted = { worktree: { id: 'repo-ssh-1::/home/dev/repo' } }
    adoptMock.mockResolvedValue(adopted as never)

    const creation = await createProvisionedRootRecipeWorkspace(deps, args)

    expect(creation.result).toBe(adopted)
    expect(creation.sshTargetId).toBe('target-1')
    const env = JSON.parse(readFileSync(envPath, 'utf8'))
    expect(env.ORCA_REPO_BRANCH).toBe('feat-x')
    expect(env.ORCA_REPO_REF).toBe('origin/main')
    expect(env.ORCA_REPO_REF_HEAD).toBe('abc123')
    expect(env.ORCA_RECIPE_RESULT_SCHEMA_VERSION).toBe('2')
    expect(addRemoteRepoMock).toHaveBeenCalledWith(
      deps.store,
      expect.objectContaining({ connectionId: 'target-1', remotePath: '/home/dev/repo' })
    )
    expect(alignRepoMock).toHaveBeenCalledWith(
      deps.store,
      expect.objectContaining({ id: 'repo-ssh-1' }),
      'github:acme/repo',
      'imported-existing-folder',
      undefined
    )
    expect(adoptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          repoId: 'repo-ssh-1',
          branchNameOverride: 'feat-x',
          runtimeId: creation.runtimeId,
          executionHostId: 'ssh:target-1',
          expectedPath: '/home/dev/repo',
          expectedRefHead: 'abc123'
        })
      })
    )
    const runtimes = listEphemeralVmRuntimes(deps.userDataPath)
    expect(runtimes).toHaveLength(1)
    expect(runtimes[0].sshTargetId).toBe('target-1')
  })

  it('rejects recipes without provisioned-root checkout before running any script', async () => {
    const { repoDir, envPath } = writeRecipeRepo({})
    const repo = makeRepo(repoDir)

    await expect(
      createProvisionedRootRecipeWorkspace(makeDeps(repo), makeArgs(repo))
    ).rejects.toThrow(/not a provisioned-root recipe/)
    expect(existsSync(envPath)).toBe(false)
  })

  it('destroys the provisioned environment when the SSH connect fails', async () => {
    const { repoDir, destroyMarkerPath } = writeRecipeRepo({ checkoutMode: 'provisioned-root' })
    const repo = makeRepo(repoDir)
    const deps = makeDeps(repo)
    connectMock.mockRejectedValue(new Error('ssh boom'))

    await expect(createProvisionedRootRecipeWorkspace(deps, makeArgs(repo))).rejects.toThrow(
      'ssh boom'
    )
    expect(readFileSync(destroyMarkerPath, 'utf8')).toBe('x')
  })

  it('destroys the provisioned environment when adoption fails', async () => {
    const { repoDir, destroyMarkerPath } = writeRecipeRepo({ checkoutMode: 'provisioned-root' })
    const repo = makeRepo(repoDir)
    const deps = makeDeps(repo)
    connectMock.mockResolvedValue({
      targetId: 'target-1',
      target: { id: 'target-1' }
    } as unknown as Awaited<ReturnType<typeof connectRuntimeOwnedSshTarget>>)
    adoptMock.mockRejectedValue(new Error('adopt boom'))

    await expect(createProvisionedRootRecipeWorkspace(deps, makeArgs(repo))).rejects.toThrow(
      'adopt boom'
    )
    expect(readFileSync(destroyMarkerPath, 'utf8')).toBe('x')
  })
})

describe('cleanupRecipeRuntimesForWorkspace', () => {
  it('destroys the runtime attached to the removed workspace and skips others', async () => {
    const { repoDir, destroyMarkerPath } = writeRecipeRepo({ checkoutMode: 'provisioned-root' })
    const repo = makeRepo(repoDir)
    const deps = makeDeps(repo)
    const args = makeArgs(repo)
    connectMock.mockResolvedValue({
      targetId: 'target-1',
      target: { id: 'target-1' }
    } as unknown as Awaited<ReturnType<typeof connectRuntimeOwnedSshTarget>>)
    adoptMock.mockImplementation(async (adoption) => {
      const { attachEphemeralVmRuntimeToWorkspace } = await import(
        './ephemeral-vm-runtime-attachment'
      )
      attachEphemeralVmRuntimeToWorkspace({
        userDataPath: deps.userDataPath,
        runtimeId: adoption.request.runtimeId,
        workspaceId: 'repo-ssh-1::/home/dev/repo'
      })
      return { worktree: { id: 'repo-ssh-1::/home/dev/repo' } } as never
    })
    await createProvisionedRootRecipeWorkspace(deps, args)

    await cleanupRecipeRuntimesForWorkspace(deps, 'repo-ssh-1::/somewhere-else')
    expect(existsSync(destroyMarkerPath)).toBe(false)

    await cleanupRecipeRuntimesForWorkspace(deps, 'repo-ssh-1::/home/dev/repo')
    expect(readFileSync(destroyMarkerPath, 'utf8')).toBe('x')
    const runtime = listEphemeralVmRuntimes(deps.userDataPath)[0]
    expect(runtime.cleanupStatus).toBe('succeeded')
    expect(runtime.sshTargetId).toBeUndefined()
  })
})
