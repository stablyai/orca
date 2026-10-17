import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { getDefaultPersistedState } from '../../shared/constants'
import type { Repo } from '../../shared/repo-types'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import {
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime
} from '../../shared/ephemeral-vm-runtime-store'
import { Store } from '../persistence'
import type * as RecipeRunner from '../ephemeral-vm-recipe-runner'

type HandlerArgs = { runtimeId: string } | { workspaceId: string }
const handlers = new Map<string, (_event: unknown, args: HandlerArgs) => unknown>()
const { getPath, handle, removeTarget, releaseEnvironments, cleanup, suspend, resume } = vi.hoisted(
  () => ({
    getPath: vi.fn(),
    handle: vi.fn(),
    removeTarget: vi.fn(),
    releaseEnvironments: vi.fn(),
    cleanup: vi.fn(),
    suspend: vi.fn(),
    resume: vi.fn()
  })
)

vi.mock('electron', () => ({
  app: { getPath },
  ipcMain: { handle, removeHandler: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../ephemeral-vm-runtime-ssh', () => ({
  connectRuntimeOwnedSshTarget: vi.fn(),
  disconnectRuntimeOwnedSshTarget: vi.fn(),
  removeRuntimeOwnedSshTarget: removeTarget
}))
vi.mock('../ephemeral-vm-runtime-environment-release', () => ({
  releaseEphemeralVmRuntimeEnvironments: releaseEnvironments
}))
vi.mock('../ephemeral-vm-recipe-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof RecipeRunner>()
  cleanup.mockImplementation(actual.runEphemeralVmRecipeCleanup)
  return {
    ...actual,
    runEphemeralVmRecipeCleanup: cleanup,
    runEphemeralVmRecipeSuspend: suspend,
    runEphemeralVmRecipeResume: resume
  }
})

import { registerEphemeralVmRuntimeHandlers } from './ephemeral-vm-runtime-handlers'

let userDataPath: string
let repoPath: string

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'original-repo',
    path: repoPath,
    displayName: 'Source',
    badgeColor: '',
    addedAt: 1,
    ...overrides
  }
}

function saveRuntime(overrides: Partial<EphemeralVmRuntimeRecord> = {}) {
  return upsertEphemeralVmRuntime(userDataPath, {
    id: 'runtime-1',
    recipeId: 'sandbox',
    repoId: 'original-repo',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    workspaceName: 'Fix',
    recipe: {
      id: 'sandbox',
      name: 'Sandbox',
      create: 'unused',
      destroy: `"${process.execPath}" "destroy.cjs"`,
      suspend: 'unused',
      resume: 'unused'
    },
    recipeSource: { executionHostId: 'local', repoPath },
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    connectionMode: 'ssh',
    sshTargetId: 'runtime-ssh',
    runtimeEnvironmentId: 'environment-1',
    recipeResult: {
      schemaVersion: 1,
      connection: {
        type: 'ssh',
        projectRoot: '/remote/workspace',
        target: { label: 'VM', host: 'vm.invalid', port: 22, username: 'orca' }
      },
      userData: { providerResourceId: 'original-vm' }
    },
    ...overrides
  })
}

function register(repos: Repo[] = []) {
  registerEphemeralVmRuntimeHandlers(
    new Store({
      dataFile: join(userDataPath, 'orca-data.json'),
      serializedState: JSON.stringify({ ...getDefaultPersistedState(userDataPath), repos })
    })
  )
}

async function invoke(channel: string, args: HandlerArgs = { runtimeId: 'runtime-1' }) {
  const handler = handlers.get(`ephemeralVm:${channel}`)
  if (!handler) {
    throw new Error(`Missing handler: ${channel}`)
  }
  return await handler(null, args)
}

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-orphan-recipe-'))
  repoPath = join(userDataPath, 'original-source')
  mkdirSync(repoPath)
  getPath.mockReturnValue(userDataPath)
  installFakeAppEnvironment({ getPath: () => userDataPath })
  removeTarget.mockResolvedValue(undefined)
  releaseEnvironments.mockResolvedValue(undefined)
  handle.mockImplementation(
    (channel: string, handler: (_event: unknown, args: HandlerArgs) => unknown) => {
      handlers.set(channel, handler)
    }
  )
})

afterEach(() => rmSync(userDataPath, { recursive: true, force: true }))

it('destroys once with the saved command, original cwd and provider payload after re-adding the project', async () => {
  const runtime = saveRuntime()
  register([repo()])
  register([repo({ id: 'readded-repo' })])
  writeFileSync(
    join(repoPath, 'destroy.cjs'),
    [
      "let stdin = ''",
      "process.stdin.on('data', chunk => { stdin += chunk })",
      "process.stdin.on('end', () => {",
      "  require('fs').appendFileSync('destroyed.jsonl', JSON.stringify({ cwd: process.cwd(), payload: JSON.parse(stdin) }) + '\\n')",
      '})'
    ].join('\n')
  )
  const expectedPayload = {
    schemaVersion: 1,
    mode: 'destroy',
    recipeId: 'sandbox',
    instanceId: 'runtime-1',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    workspaceName: 'Fix',
    recipeResult: runtime.recipeResult
  }
  const copy = await invoke('getCleanupCommand')
  expect(copy).toMatchObject({
    cleanupDisabled: false,
    payloadJson: JSON.stringify(expectedPayload, null, 2)
  })
  expect(copy).toHaveProperty(
    'command',
    expect.stringContaining(runtime.recipe?.destroy ?? 'missing destroy')
  )

  await expect(invoke('cleanup')).resolves.toMatchObject({
    status: 'cleaned',
    cleanupStatus: 'succeeded'
  })
  await expect(invoke('cleanup')).resolves.toMatchObject({ status: 'cleaned' })

  const observations = readFileSync(join(repoPath, 'destroyed.jsonl'), 'utf8').trim().split('\n')
  expect(observations).toHaveLength(1)
  expect(JSON.parse(observations[0])).toEqual({
    cwd: realpathSync(repoPath),
    payload: expectedPayload
  })
  expect(cleanup).toHaveBeenCalledTimes(1)
  expect(releaseEnvironments).toHaveBeenCalledWith(
    userDataPath,
    expect.objectContaining({ id: runtime.id })
  )
  expect(removeTarget).toHaveBeenCalledWith('runtime-ssh')
})

it.each(['suspendWorkspace', 'resumeWorkspace'])(
  'keeps %s restricted to registered projects',
  async (channel) => {
    saveRuntime({ status: 'suspended' })
    register()
    await expect(invoke(channel, { workspaceId: 'workspace-1' })).rejects.toThrow('Repo not found')
    expect(suspend).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  }
)

it.each(['recipeSource', 'recipe'] as const)(
  'refuses orphan cleanup without the saved %s',
  async (field) => {
    saveRuntime({ [field]: undefined })
    register([repo({ id: 'readded-repo' })])
    await expect(invoke('getCleanupCommand')).rejects.toThrow('Repo not found')
    await expect(invoke('cleanup')).resolves.toMatchObject({
      status: 'cleanup_failed',
      cleanupStatus: 'failed'
    })
    expect(cleanup).not.toHaveBeenCalled()
    expect(releaseEnvironments).not.toHaveBeenCalled()
  }
)

it('refuses a relative saved source before starting cleanup', async () => {
  saveRuntime({
    recipeSource: { executionHostId: 'local', repoPath: relative(process.cwd(), repoPath) }
  })
  register()
  await expect(invoke('getCleanupCommand')).rejects.toThrow('not absolute')
  await expect(invoke('cleanup')).resolves.toMatchObject({
    status: 'cleanup_failed',
    cleanupStatus: 'failed'
  })
  expect(cleanup).not.toHaveBeenCalled()
  expect(releaseEnvironments).not.toHaveBeenCalled()
})

it.each(['missing', 'file'])(
  'retains retry state and copyable commands for a %s saved source',
  async (kind) => {
    const file = join(userDataPath, 'file')
    writeFileSync(file, 'not a directory')
    const sourcePath = kind === 'missing' ? join(userDataPath, 'deleted-source') : file
    saveRuntime({ recipeSource: { executionHostId: 'local', repoPath: sourcePath } })
    register()
    await expect(invoke('getCleanupCommand')).resolves.toMatchObject({ cleanupDisabled: false })
    await expect(invoke('cleanup')).rejects.toThrow()
    expect(listEphemeralVmRuntimes(userDataPath)[0]).toMatchObject({
      status: 'cleanup_failed',
      cleanupStatus: 'failed',
      sshTargetId: 'runtime-ssh'
    })
    expect(removeTarget).not.toHaveBeenCalled()
    expect(releaseEnvironments).not.toHaveBeenCalled()
  }
)

it.each([
  { kind: 'folder' as const },
  { connectionId: 'ssh-other', executionHostId: 'ssh:ssh-other' as const }
])('does not bypass an existing same-id project with %o', async (overrides) => {
  saveRuntime()
  register([repo(overrides)])
  await expect(invoke('getCleanupCommand')).rejects.toThrow()
  await expect(invoke('cleanup')).resolves.toMatchObject({
    status: 'cleanup_failed',
    cleanupStatus: 'failed'
  })
  expect(cleanup).not.toHaveBeenCalled()
  expect(releaseEnvironments).not.toHaveBeenCalled()
})

it('retains hidden targets when a registered project cleanup runner throws', async () => {
  saveRuntime()
  const registeredPath = join(userDataPath, 'registered-source')
  mkdirSync(registeredPath)
  register([repo({ path: registeredPath })])
  cleanup.mockRejectedValueOnce(new Error('source disappeared after resolution'))
  await expect(invoke('cleanup')).rejects.toThrow('source disappeared after resolution')
  expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({ repoPath: registeredPath }))
  expect(listEphemeralVmRuntimes(userDataPath)[0]).toMatchObject({
    status: 'cleanup_failed',
    cleanupStatus: 'failed',
    sshTargetId: 'runtime-ssh'
  })
  expect(removeTarget).not.toHaveBeenCalled()
  expect(releaseEnvironments).not.toHaveBeenCalled()
})
