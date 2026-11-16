import '../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../shared/testing/remove-temp-dirs.test-support'
import { encodePairingOffer } from '../../shared/remote-runtime/pairing/pairing'
import { PAIRING_OFFER_VERSION } from '../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { listEphemeralVmRuntimes } from '../../shared/remote-runtime/ephemeral-vm-store/ephemeral-vm-runtime-store'
import type { RecipeWorkspaceCreationHooks } from '../runtime/workspaces/sleep/runtime-workspace-sleep-operations'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Store } from '../persistence/loading-store/store'
import type { Repo } from '../../shared/repository/repo-types'
import type { RuntimeRpcProgress } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'

type EnvironmentHandler = (params: unknown, signal?: AbortSignal) => unknown

const { getPathMock, environment } = vi.hoisted(() => {
  const handlers: Record<string, EnvironmentHandler> = {}
  const calls: { method: string; params: unknown }[] = []
  // The recipe-created environment's own Orca server, faked at the RPC boundary.
  return { getPathMock: vi.fn(), environment: { handlers, calls } }
})

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: getPathMock }
}))
vi.mock('../ipc/runtime-environments/runtime-environments', () => ({
  invalidateRuntimeEnvironmentTransport: vi.fn(async () => {})
}))
vi.mock('./runtime-ssh', () => ({
  connectRuntimeOwnedSshTarget: vi.fn(),
  disconnectRuntimeOwnedSshTarget: vi.fn(),
  removeRuntimeOwnedSshTarget: vi.fn()
}))
vi.mock('../ipc/runtime-environments/requests/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: async (
    _root: string,
    _selector: string,
    method: string,
    params: unknown,
    _timeoutMs?: number,
    _revision?: number,
    _envelope?: unknown,
    options?: { signal?: AbortSignal }
  ) => {
    environment.calls.push({ method, params })
    const meta = { runtimeId: 'vm-orca' }
    const handler = environment.handlers[method]
    if (!handler) {
      return {
        id: method,
        ok: false,
        error: { code: 'method_not_found', message: method },
        _meta: meta
      }
    }
    try {
      return { id: method, ok: true, result: await handler(params, options?.signal), _meta: meta }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { id: method, ok: false, error: { code: 'runtime_error', message }, _meta: meta }
    }
  }
}))

import { wireRecipeWorkspaceCreation } from './recipe-workspace-create-wiring'
import { pendingVmCheckouts } from './pending-vm-checkouts'

// What the fake environment reads from the requests it serves.
const SetupParams = z.object({ path: z.string(), projectId: z.string() })
const CreateParams = z.object({ name: z.string() })

const tempDirs: string[] = []
afterEach(async () => {
  await removeTempDirs(tempDirs.splice(0))
  environment.calls.length = 0
})

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** A fake recipe: create boots nothing but answers like an orca-server VM; destroy leaves a marker. */
function setUpRecipeCreate(options: { projectRoot: string; cloudVms?: boolean }) {
  const userDataPath = makeDir('orca-recipe-create-user-data-')
  const repoPath = makeDir('orca-recipe-create-repo-')
  getPathMock.mockReturnValue(userDataPath)
  const pairingCode = encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint: 'wss://vm.example.invalid',
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  })
  const created = join(repoPath, 'created.txt')
  const destroyed = join(repoPath, 'destroyed.txt')
  writeFileSync(
    join(repoPath, 'create.js'),
    `require('fs').writeFileSync(${JSON.stringify(created)}, 'x')
process.stderr.write('booting fake vm\\n')
console.log(JSON.stringify({ schemaVersion: 1, pairingCode: ${JSON.stringify(pairingCode)}, projectRoot: ${JSON.stringify(options.projectRoot)} }))\n`
  )
  writeFileSync(
    join(repoPath, 'destroy.js'),
    `require('fs').writeFileSync(${JSON.stringify(destroyed)}, 'x')\n`
  )
  writeFileSync(
    join(repoPath, 'orca.yaml'),
    [
      'environmentRecipes:',
      '  - id: fake-vm',
      '    name: Fake VM',
      `    create: '"${process.execPath}" create.js'`,
      `    destroy: '"${process.execPath}" destroy.js'`
    ].join('\n')
  )
  const repo = { id: 'repo-1', path: repoPath, displayName: 'Repo', badgeColor: '#000', addedAt: 0 }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create and its cleanup read only these store methods.
  const store = {
    getSettings: () => ({ experimentalEphemeralVms: options.cloudVms !== false }),
    getRepo: (id: string) => (id === repo.id ? repo : undefined),
    getRepos: () => [repo],
    getProjects: () => [],
    getProjectHostSetups: () => [],
    removeWorkspaceSessionHost: vi.fn(),
    getRemoteLayoutSnapshot: vi.fn(),
    setRemoteLayoutSnapshot: vi.fn(),
    setHostRepoCatalogSnapshot: vi.fn()
  } as unknown as Store
  let hooks: RecipeWorkspaceCreationHooks | undefined
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wiring only registers its hooks.
  const runtime = {
    setRecipeWorkspaceCreation: (registered: RecipeWorkspaceCreationHooks) => {
      hooks = registered
    }
  } as unknown as OrcaRuntimeService
  wireRecipeWorkspaceCreation(runtime, store, () => userDataPath)
  environment.handlers = {
    'status.get': () => ({
      capabilities: ['project-host-setup.v1', 'workspace-run-context.v1', 'environment.doctor.v1']
    }),
    'projectHostSetup.setupExistingFolder': (params) => {
      const { path, projectId } = SetupParams.parse(params)
      return {
        result: {
          project: { id: projectId },
          repo: { id: 'vm-repo', path, displayName: 'Repo', badgeColor: '#000', addedAt: 0 },
          setup: { id: 'vm-setup', projectId, repoId: 'vm-repo', hostId: 'local', path }
        }
      }
    },
    'environment.doctor': () => ({ worktreePath: options.projectRoot, ok: true, checks: [] }),
    'worktree.create': (params) => {
      const { name } = CreateParams.parse(params)
      return {
        worktree: { id: `vm-repo::/workspace/trees/${name}`, repoId: 'vm-repo', branch: name }
      }
    }
  }
  const create = (
    params: Partial<Parameters<RecipeWorkspaceCreationHooks['create']>[0]>,
    extra: Parameters<RecipeWorkspaceCreationHooks['create']>[2] = {}
  ) =>
    hooks!.create(
      { recipeId: 'fake-vm', repo: 'id:repo-1', name: 'fix-login', ...params },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create reads only the repo's id and path.
      repo as unknown as Repo,
      extra
    )
  return { userDataPath, created, destroyed, create }
}

function environmentMethods(): string[] {
  return environment.calls.map((call) => call.method)
}

describe('recipe workspace create (orca worktree create --on recipe:<id>)', () => {
  it('creates the workspace on the new host and links it to its VM record', async () => {
    const recipe = setUpRecipeCreate({ projectRoot: '/workspace/success' })
    let hiddenDuringCreate: unknown
    const createOnHost = environment.handlers['worktree.create']
    environment.handlers['worktree.create'] = (params) => {
      hiddenDuringCreate = pendingVmCheckouts.list()
      return createOnHost(params)
    }
    const progress: RuntimeRpcProgress[] = []

    const result = await recipe.create(
      { baseBranch: 'origin/main', setupDecision: 'skip' },
      { onProgress: (entry) => progress.push(entry) }
    )

    expect(result.worktree.id).toBe('vm-repo::/workspace/trees/fix-login')
    expect(result.host.id).toBe(`runtime:${result.host.environmentId}`)
    expect(environment.calls.find((call) => call.method === 'worktree.create')?.params).toEqual(
      expect.objectContaining({
        repo: 'id:vm-repo',
        name: 'fix-login',
        baseBranch: 'origin/main',
        setupDecision: 'skip'
      })
    )
    const [vm] = listEphemeralVmRuntimes(recipe.userDataPath)
    expect(vm).toMatchObject({
      id: result.host.runtimeId,
      status: 'running',
      workspaceId: 'vm-repo::/workspace/trees/fix-login',
      runtimeEnvironmentId: result.host.environmentId
    })
    expect(hiddenDuringCreate).toContainEqual({ repoId: 'vm-repo', path: '/workspace/success' })
    expect(pendingVmCheckouts.list()).not.toContainEqual({
      repoId: 'vm-repo',
      path: '/workspace/success'
    })
    expect(progress.filter((entry) => entry.phase !== undefined)).toEqual([
      { phase: 'running-create' },
      { phase: 'connecting' },
      { phase: 'registering-project' },
      { phase: 'checking-environment' },
      { phase: 'creating-workspace' }
    ])
    expect(progress).toContainEqual({ output: 'booting fake vm\n' })
    expect(existsSync(recipe.destroyed)).toBe(false)
  })

  it('destroys the new environment when the workspace create fails on it', async () => {
    const recipe = setUpRecipeCreate({ projectRoot: '/workspace/create-fails' })
    environment.handlers['worktree.create'] = () => {
      throw new Error('No space left on device')
    }

    const failure = recipe.create({})

    await expect(failure).rejects.toMatchObject({
      code: 'recipe_workspace_create_failed',
      data: { phase: 'creating-workspace', recipeId: 'fake-vm', environment: 'destroyed' }
    })
    expect(existsSync(recipe.destroyed)).toBe(true)
    expect(listEphemeralVmRuntimes(recipe.userDataPath)).toMatchObject([
      { status: 'cleaned', cleanupStatus: 'succeeded' }
    ])
  })

  it('stops before creating when the environment fails its checks, and destroys it', async () => {
    const recipe = setUpRecipeCreate({ projectRoot: '/workspace/checks-fail' })
    const missingTool = {
      id: 'tool.pnpm',
      category: 'tools',
      status: 'fail',
      message: 'pnpm is not on PATH.'
    }
    environment.handlers['environment.doctor'] = () => ({
      worktreePath: '/workspace/checks-fail',
      ok: false,
      checks: [{ id: 'tool.git', category: 'tools', status: 'pass', message: 'ok' }, missingTool]
    })

    await expect(recipe.create({})).rejects.toMatchObject({
      code: 'recipe_workspace_create_failed',
      data: {
        phase: 'checking-environment',
        environment: 'destroyed',
        environmentChecks: [missingTool]
      }
    })
    expect(environmentMethods()).not.toContain('worktree.create')
    expect(existsSync(recipe.destroyed)).toBe(true)
  })

  it('destroys the environment when the caller cancels after it was created', async () => {
    const recipe = setUpRecipeCreate({ projectRoot: '/workspace/cancelled' })
    const controller = new AbortController()
    // Ctrl+C on the CLI closes its socket while the environment checks run.
    environment.handlers['environment.doctor'] = (_params, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        controller.abort()
      })

    const error = await recipe.create({}, { signal: controller.signal }).catch((caught) => caught)

    expect(error).toMatchObject({
      code: 'recipe_workspace_create_failed',
      data: { phase: 'checking-environment', environment: 'destroyed' }
    })
    // A cancel is not reported as failed checks.
    expect(error.data).not.toHaveProperty('environmentChecks')
    expect(environmentMethods()).not.toContain('worktree.create')
    expect(existsSync(recipe.destroyed)).toBe(true)
  })

  it('refuses while Cloud VMs are turned off, before the recipe runs', async () => {
    const recipe = setUpRecipeCreate({ projectRoot: '/workspace/off', cloudVms: false })

    await expect(recipe.create({})).rejects.toMatchObject({ code: 'cloud_vms_disabled' })
    expect(existsSync(recipe.created)).toBe(false)
    expect(environment.calls).toEqual([])
  })
})
