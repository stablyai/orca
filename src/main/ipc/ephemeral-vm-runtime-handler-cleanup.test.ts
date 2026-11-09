import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { upsertEphemeralVmRuntime } from '../../shared/ephemeral-vm-runtime-store'
import type * as RuntimeEnvironmentStore from '../../shared/remote-runtime/host-store/runtime-environment-store'

const handlers = new Map<string, (_event: unknown, args: { runtimeId: string }) => unknown>()
const { getPathMock, handleMock, removeRuntimeOwnedSshTargetMock, removeHandlerMock } = vi.hoisted(
  () => ({
    getPathMock: vi.fn(),
    handleMock: vi.fn(),
    removeRuntimeOwnedSshTargetMock: vi.fn(),
    removeHandlerMock: vi.fn()
  })
)

vi.mock('electron', () => ({
  app: { getPath: getPathMock },
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

const { listEnvironmentsMock, removeEnvironmentMock } = vi.hoisted(() => ({
  listEnvironmentsMock: vi.fn((): { id: string }[] => []),
  removeEnvironmentMock: vi.fn()
}))

vi.mock(
  '../../shared/remote-runtime/host-store/runtime-environment-store',
  async (importOriginal) => ({
    ...(await importOriginal<typeof RuntimeEnvironmentStore>()),
    listEnvironments: listEnvironmentsMock,
    removeEnvironment: removeEnvironmentMock
  })
)

vi.mock('./runtime-environments/runtime-environments', () => ({
  invalidateRuntimeEnvironmentTransport: vi.fn(async () => {})
}))

vi.mock('../ephemeral-vm/runtime-ssh', () => ({
  connectRuntimeOwnedSshTarget: vi.fn(),
  disconnectRuntimeOwnedSshTarget: vi.fn(),
  removeRuntimeOwnedSshTarget: removeRuntimeOwnedSshTargetMock
}))

import { registerEphemeralVmRuntimeHandlers } from './ephemeral-vm-runtime-handlers'

const tempDirs: string[] = []

function nodeCommand(scriptPath: string): string {
  return `"${process.execPath}" "${scriptPath}"`
}

beforeEach(() => {
  handlers.clear()
  handleMock.mockReset()
  removeRuntimeOwnedSshTargetMock.mockReset().mockResolvedValue(undefined)
  removeHandlerMock.mockReset()
  handleMock.mockImplementation(
    (channel: string, handler: (_event: unknown, args: { runtimeId: string }) => unknown) => {
      handlers.set(channel, handler)
    }
  )
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('removes the hidden SSH target when provider cleanup cannot start', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-vm-runtime-handler-'))
  tempDirs.push(userDataPath)
  getPathMock.mockReturnValue(userDataPath)
  upsertEphemeralVmRuntime(userDataPath, {
    id: 'runtime-missing-context',
    recipeId: 'cloud-sandbox',
    repoId: 'missing-repo',
    status: 'cleanup_failed',
    cleanupStatus: 'not_started',
    connectionMode: 'ssh',
    sshTargetId: 'runtime-ssh-missing-context',
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 1,
      connection: {
        type: 'ssh',
        projectRoot: '/workspace/repo',
        target: { label: 'VM', host: 'host', port: 22, username: 'orca' }
      }
    }
  })
  registerEphemeralVmRuntimeHandlers({ getRepo: vi.fn() } as never)

  const cleaned = await handlers.get('ephemeralVm:cleanup')?.(null, {
    runtimeId: 'runtime-missing-context'
  })

  expect(cleaned).toMatchObject({
    status: 'cleanup_failed',
    cleanupStatus: 'failed',
    connectionMode: undefined,
    sshTargetId: undefined
  })
  expect(removeRuntimeOwnedSshTargetMock).toHaveBeenCalledWith('runtime-ssh-missing-context')
})

it('stops in-flight cleanup and retains the runtime for retry', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-vm-runtime-handler-'))
  const repoPath = mkdtempSync(join(tmpdir(), 'orca-vm-runtime-repo-'))
  tempDirs.push(userDataPath, repoPath)
  getPathMock.mockReturnValue(userDataPath)
  const destroyPath = join(repoPath, 'destroy.js')
  const destroyStartedPath = join(repoPath, 'destroy-started.txt')
  writeFileSync(
    destroyPath,
    `require('fs').writeFileSync(${JSON.stringify(destroyStartedPath)}, 'yes'); setInterval(() => {}, 1000)`
  )
  upsertEphemeralVmRuntime(userDataPath, {
    id: 'runtime-stop',
    recipeId: 'cloud-sandbox',
    recipe: {
      id: 'cloud-sandbox',
      name: 'Cloud Sandbox',
      create: 'unused',
      destroy: nodeCommand(destroyPath)
    },
    repoId: 'repo-1',
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 1,
      connection: {
        type: 'ssh',
        projectRoot: '/workspace/repo',
        target: { label: 'VM', host: 'host', port: 22, username: 'orca' }
      }
    }
  })
  registerEphemeralVmRuntimeHandlers({
    getRepo: vi.fn(() => ({
      id: 'repo-1',
      path: repoPath,
      displayName: 'Repo',
      badgeColor: '#000',
      addedAt: 0
    }))
  } as never)

  const cleanup = handlers.get('ephemeralVm:cleanup')?.(null, {
    runtimeId: 'runtime-stop'
  }) as Promise<{ status: string }>
  await vi.waitFor(() => expect(existsSync(destroyStartedPath)).toBe(true))
  const stopped = await handlers.get('ephemeralVm:stopCleanup')?.(null, {
    runtimeId: 'runtime-stop'
  })

  expect(stopped).toMatchObject({
    status: 'cleanup_failed',
    cleanupStatus: 'failed',
    cleanupLastError: 'Cleanup stopped by user.'
  })
  await expect(cleanup).resolves.toMatchObject({ status: 'cleanup_failed' })
})

it("retires a recipe server's session partition once its VM is destroyed (#33805)", async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-vm-runtime-handler-'))
  const repoPath = mkdtempSync(join(tmpdir(), 'orca-vm-runtime-repo-'))
  tempDirs.push(userDataPath, repoPath)
  getPathMock.mockReturnValue(userDataPath)
  const destroyPath = join(repoPath, 'destroy.js')
  writeFileSync(destroyPath, 'process.exit(0)')
  listEnvironmentsMock.mockReturnValue([{ id: 'env-recipe' }])
  upsertEphemeralVmRuntime(userDataPath, {
    id: 'runtime-paired',
    recipeId: 'cloud-sandbox',
    recipe: {
      id: 'cloud-sandbox',
      name: 'Cloud Sandbox',
      create: 'unused',
      destroy: nodeCommand(destroyPath)
    },
    repoId: 'repo-1',
    workspaceId: 'test1',
    runtimeEnvironmentId: 'env-recipe',
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 1,
      connection: { type: 'orca-server', pairingCode: 'unused', projectRoot: '/workspace/repo' }
    }
  })
  const removeWorkspaceSessionHost = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cleanup reads only getRepo and the removed-server store methods this fake implements.
  registerEphemeralVmRuntimeHandlers({
    getRepo: vi.fn(() => ({
      id: 'repo-1',
      path: repoPath,
      displayName: 'Repo',
      badgeColor: '#000',
      addedAt: 0
    })),
    removeWorkspaceSessionHost,
    getRemoteLayoutSnapshot: vi.fn(),
    setRemoteLayoutSnapshot: vi.fn(),
    setHostRepoCatalogSnapshot: vi.fn()
  } as never)

  await expect(
    handlers.get('ephemeralVm:cleanup')?.(null, { runtimeId: 'runtime-paired' })
  ).resolves.toMatchObject({ cleanupStatus: 'succeeded' })

  expect(removeEnvironmentMock).toHaveBeenCalledWith(userDataPath, 'env-recipe')
  expect(removeWorkspaceSessionHost).toHaveBeenCalledWith('runtime:env-recipe')
})

it('destroys from the recorded snapshot and repo path when the repo id no longer resolves (#17293)', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-vm-runtime-handler-'))
  const repoPath = mkdtempSync(join(tmpdir(), 'orca-vm-runtime-repo-'))
  tempDirs.push(userDataPath, repoPath)
  getPathMock.mockReturnValue(userDataPath)
  const destroyedPath = join(repoPath, 'destroyed.txt')
  writeFileSync(
    join(repoPath, 'destroy.js'),
    `require('fs').writeFileSync(${JSON.stringify(destroyedPath)}, process.cwd())`
  )
  const recipe = {
    id: 'cloud-sandbox',
    name: 'Cloud Sandbox',
    create: './create.sh',
    destroy: `"${process.execPath}" destroy.js`
  }
  // The checkout still defines the recipe the VM was created from.
  writeFileSync(
    join(repoPath, 'orca.yaml'),
    [
      'environmentRecipes:',
      '  - id: cloud-sandbox',
      '    name: Cloud Sandbox',
      '    create: ./create.sh'
    ].join('\n')
  )
  upsertEphemeralVmRuntime(userDataPath, {
    id: 'runtime-stale-repo',
    recipeId: 'cloud-sandbox',
    recipe,
    repoId: 'removed-repo',
    repoPath,
    status: 'cleanup_failed',
    cleanupStatus: 'failed',
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 1,
      connection: { type: 'orca-server', pairingCode: 'unused', projectRoot: '/workspace/repo' }
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these cleanup paths only read getRepo from the store.
  registerEphemeralVmRuntimeHandlers({ getRepo: vi.fn(() => undefined) } as never)

  await expect(
    handlers.get('ephemeralVm:getCleanupCommand')?.(null, { runtimeId: 'runtime-stale-repo' })
  ).resolves.toMatchObject({ command: expect.stringContaining('destroy.js') })

  await expect(
    handlers.get('ephemeralVm:cleanup')?.(null, { runtimeId: 'runtime-stale-repo' })
  ).resolves.toMatchObject({ status: 'cleaned', cleanupStatus: 'succeeded' })
  expect(existsSync(destroyedPath)).toBe(true)
})

it('refuses the recorded repo path once a different checkout sits there', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-vm-runtime-handler-'))
  const repoPath = mkdtempSync(join(tmpdir(), 'orca-vm-runtime-repo-'))
  tempDirs.push(userDataPath, repoPath)
  getPathMock.mockReturnValue(userDataPath)
  const ranPath = join(repoPath, 'ran.txt')
  writeFileSync(
    join(repoPath, 'destroy.js'),
    `require('fs').writeFileSync(${JSON.stringify(ranPath)}, 'x')`
  )
  writeFileSync(
    join(repoPath, 'orca.yaml'),
    [
      'environmentRecipes:',
      '  - id: cloud-sandbox',
      '    name: Other',
      '    create: ./other.sh'
    ].join('\n')
  )
  upsertEphemeralVmRuntime(userDataPath, {
    id: 'runtime-moved-repo',
    recipeId: 'cloud-sandbox',
    recipe: {
      id: 'cloud-sandbox',
      name: 'Cloud Sandbox',
      create: './create.sh',
      destroy: `"${process.execPath}" destroy.js`
    },
    repoId: 'removed-repo',
    repoPath,
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 1,
      connection: { type: 'orca-server', pairingCode: 'unused', projectRoot: '/workspace/repo' }
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these cleanup paths only read getRepo from the store.
  registerEphemeralVmRuntimeHandlers({ getRepo: vi.fn(() => undefined) } as never)

  await expect(
    handlers.get('ephemeralVm:cleanup')?.(null, { runtimeId: 'runtime-moved-repo' })
  ).resolves.toMatchObject({ status: 'cleanup_failed', cleanupLastErrorCode: 'repoNotFound' })
  expect(existsSync(ranPath)).toBe(false)
})

it('still refuses cleanup when the repo id is stale and no repo path was recorded', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-vm-runtime-handler-'))
  tempDirs.push(userDataPath)
  getPathMock.mockReturnValue(userDataPath)
  upsertEphemeralVmRuntime(userDataPath, {
    id: 'runtime-legacy-stale-repo',
    recipeId: 'cloud-sandbox',
    recipe: { id: 'cloud-sandbox', name: 'Cloud Sandbox', create: 'unused', destroy: 'unused' },
    repoId: 'removed-repo',
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 1,
      connection: { type: 'orca-server', pairingCode: 'unused', projectRoot: '/workspace/repo' }
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these cleanup paths only read getRepo from the store.
  registerEphemeralVmRuntimeHandlers({ getRepo: vi.fn(() => undefined) } as never)

  await expect(
    handlers.get('ephemeralVm:cleanup')?.(null, { runtimeId: 'runtime-legacy-stale-repo' })
  ).resolves.toMatchObject({ status: 'cleanup_failed', cleanupLastErrorCode: 'repoNotFound' })
})

it(
  "applies the repo recipe's destroy timeout to a snapshot persisted without timeouts",
  async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-vm-runtime-handler-'))
    const repoPath = mkdtempSync(join(tmpdir(), 'orca-vm-runtime-repo-'))
    tempDirs.push(userDataPath, repoPath)
    getPathMock.mockReturnValue(userDataPath)
    writeFileSync(join(repoPath, 'destroy.js'), 'setInterval(() => {}, 1000)')
    writeFileSync(
      join(repoPath, 'orca.yaml'),
      [
        'environmentRecipes:',
        '  - id: cloud-sandbox',
        '    name: Cloud Sandbox',
        '    create: unused',
        '    timeoutSeconds:',
        '      destroy: 1'
      ].join('\n')
    )
    upsertEphemeralVmRuntime(userDataPath, {
      id: 'runtime-timeout',
      recipeId: 'cloud-sandbox',
      recipe: {
        id: 'cloud-sandbox',
        name: 'Cloud Sandbox',
        create: 'unused',
        destroy: `"${process.execPath}" destroy.js`
      },
      repoId: 'repo-1',
      status: 'running',
      cleanupStatus: 'not_started',
      createdAt: 1,
      updatedAt: 1,
      recipeResult: {
        schemaVersion: 1,
        connection: { type: 'orca-server', pairingCode: 'unused', projectRoot: '/workspace/repo' }
      }
    })
    registerEphemeralVmRuntimeHandlers({
      getRepo: vi.fn(() => ({
        id: 'repo-1',
        path: repoPath,
        displayName: 'Repo',
        badgeColor: '#000',
        addedAt: 0
      }))
    } as never)

    await expect(
      handlers.get('ephemeralVm:cleanup')?.(null, { runtimeId: 'runtime-timeout' })
    ).resolves.toMatchObject({ status: 'cleanup_failed', cleanupLastErrorCode: 'recipeTimedOut' })
  },
  // The destroy step must hit its 1s recipe timeout and then be force-stopped.
  15_000
)
