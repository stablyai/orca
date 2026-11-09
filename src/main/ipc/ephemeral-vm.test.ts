import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDirs } from '../../shared/testing/remove-temp-dirs.test-support'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/remote-runtime/pairing/pairing'
import { PAIRING_OFFER_VERSION } from '../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { listEnvironments } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime
} from '../../shared/ephemeral-vm-runtime-store'

const handlers = new Map<string, (_event: unknown, args: never) => unknown>()
const {
  handleMock,
  removeHandlerMock,
  getPathMock,
  connectRuntimeOwnedSshTargetMock,
  disconnectRuntimeOwnedSshTargetMock,
  removeRuntimeOwnedSshTargetMock,
  invalidateRuntimeEnvironmentTransportMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  getPathMock: vi.fn(),
  connectRuntimeOwnedSshTargetMock: vi.fn(),
  disconnectRuntimeOwnedSshTargetMock: vi.fn(),
  removeRuntimeOwnedSshTargetMock: vi.fn(),
  invalidateRuntimeEnvironmentTransportMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  },
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  }
}))

vi.mock('../ephemeral-vm/runtime-ssh', () => ({
  connectRuntimeOwnedSshTarget: connectRuntimeOwnedSshTargetMock,
  disconnectRuntimeOwnedSshTarget: disconnectRuntimeOwnedSshTargetMock,
  removeRuntimeOwnedSshTarget: removeRuntimeOwnedSshTargetMock
}))

vi.mock('./runtime-environments/runtime-environments', () => ({
  invalidateRuntimeEnvironmentTransport: invalidateRuntimeEnvironmentTransportMock
}))

import { registerEphemeralVmHandlers } from './ephemeral-vm'
import { suspendEphemeralVmWorkspace } from '../ephemeral-vm/workspace-suspend'
import { resumeEphemeralVmWorkspace } from '../ephemeral-vm/workspace-resume'

const tempDirs: string[] = []

afterEach(async () => {
  await removeTempDirs(tempDirs.splice(0))
})

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makePairingCode(): string {
  return encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint: 'wss://sandbox.example.com',
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  })
}

function makeStore(repoPath: string) {
  const repo = {
    id: 'repo-1',
    path: repoPath,
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 0
  }
  let activeRuntimeEnvironmentId: string | null = null
  return {
    getRepo: vi.fn((repoId: string) => (repoId === 'repo-1' ? repo : null)),
    getRepos: vi.fn(() => [repo]),
    getSettings: vi.fn(() => ({ activeRuntimeEnvironmentId })),
    updateSettings: vi.fn((updates: { activeRuntimeEnvironmentId: string | null }) => {
      activeRuntimeEnvironmentId = updates.activeRuntimeEnvironmentId
    })
  }
}

function nodeCommand(scriptPath: string): string {
  return `"${process.execPath}" "${scriptPath}"`
}

function pluginServiceWithRecipes(
  recipes: { pluginKey: string; recipe: Record<string, unknown> }[]
) {
  return {
    whenReady: vi.fn().mockResolvedValue(undefined),
    contentPacks: { vmRecipes: { list: vi.fn(() => recipes) } }
  }
}

describe('registerEphemeralVmHandlers', () => {
  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    getPathMock.mockReset()
    connectRuntimeOwnedSshTargetMock.mockReset()
    disconnectRuntimeOwnedSshTargetMock.mockReset()
    removeRuntimeOwnedSshTargetMock.mockReset()
    invalidateRuntimeEnvironmentTransportMock.mockReset()
    connectRuntimeOwnedSshTargetMock.mockResolvedValue({
      targetId: 'runtime-ssh-orca-instance-1',
      target: {
        id: 'runtime-ssh-orca-instance-1',
        label: 'Sandbox',
        host: 'sandbox.example.com',
        port: 22,
        username: 'root'
      }
    })
    disconnectRuntimeOwnedSshTargetMock.mockResolvedValue(undefined)
    removeRuntimeOwnedSshTargetMock.mockResolvedValue(undefined)
    handleMock.mockImplementation((channel: string, handler: never) => {
      handlers.set(channel, handler)
    })
  })

  it('uses an immutable plugin recipe snapshot after the plugin is removed', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-ipc-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-ipc-repo-')
    getPathMock.mockReturnValue(userDataPath)
    const startPath = join(repoPath, 'start.js')
    const destroyPath = join(repoPath, 'destroy.js')
    writeFileSync(
      startPath,
      `console.log(${JSON.stringify(
        JSON.stringify({
          schemaVersion: 1,
          pairingCode: makePairingCode(),
          projectRoot: '/workspace/repo'
        })
      )})`
    )
    writeFileSync(destroyPath, "require('fs').writeFileSync('plugin-cleaned.txt', 'yes')")
    const registrations = [
      {
        pluginKey: 'samples.recipes',
        recipe: {
          id: 'plugin-cloud',
          name: 'Plugin Cloud',
          create: nodeCommand(startPath),
          destroy: nodeCommand(destroyPath)
        }
      }
    ]
    const pluginService = pluginServiceWithRecipes(registrations)
    registerEphemeralVmHandlers(makeStore(repoPath) as never, pluginService as never)

    const provisioned = (await handlers.get('ephemeralVm:provision')?.(null, {
      repoId: 'repo-1',
      recipeId: 'plugin-cloud'
    } as never)) as { ok: true; runtime: { id: string; recipe?: { id: string } } }
    registrations.splice(0)
    const cleaned = await handlers.get('ephemeralVm:cleanup')?.(null, {
      runtimeId: provisioned.runtime.id
    } as never)

    expect(provisioned.runtime.recipe).toMatchObject({ id: 'plugin-cloud' })
    expect(cleaned).toEqual(expect.objectContaining({ status: 'cleaned' }))
    expect(readFileSync(join(repoPath, 'plugin-cleaned.txt'), 'utf8')).toBe('yes')
  })

  it('never substitutes a later same-id plugin recipe for a legacy runtime', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-ipc-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-ipc-repo-')
    getPathMock.mockReturnValue(userDataPath)
    const pluginDestroyPath = join(repoPath, 'plugin-destroy.js')
    writeFileSync(
      pluginDestroyPath,
      "require('fs').writeFileSync('plugin-destroy-ran.txt', 'unsafe')"
    )
    upsertEphemeralVmRuntime(userDataPath, {
      id: 'legacy-runtime',
      recipeId: 'shared-id',
      repoId: 'repo-1',
      status: 'running',
      cleanupStatus: 'not_started',
      createdAt: 1,
      updatedAt: 1,
      recipeResult: {
        schemaVersion: 1,
        pairingCode: makePairingCode(),
        projectRoot: '/workspace/repo'
      }
    })
    const pluginService = pluginServiceWithRecipes([
      {
        pluginKey: 'samples.recipes',
        recipe: {
          id: 'shared-id',
          name: 'Later Plugin Recipe',
          create: 'create',
          destroy: nodeCommand(pluginDestroyPath)
        }
      }
    ])
    registerEphemeralVmHandlers(makeStore(repoPath) as never, pluginService as never)

    const cleaned = await handlers.get('ephemeralVm:cleanup')?.(null, {
      runtimeId: 'legacy-runtime'
    } as never)

    expect(cleaned).toMatchObject({
      status: 'cleanup_failed',
      cleanupLastError: 'Recipe not found: shared-id'
    })
    expect(existsSync(join(repoPath, 'plugin-destroy-ran.txt'))).toBe(false)
  })

  it('retains the runtime-owned SSH target when destroy fails', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-ipc-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-ipc-repo-')
    getPathMock.mockReturnValue(userDataPath)
    mkdirSync(join(repoPath, 'scripts'), { recursive: true })
    const startPath = join(repoPath, 'scripts', 'start-ssh.js')
    const destroyPath = join(repoPath, 'scripts', 'destroy.js')
    writeFileSync(
      startPath,
      [
        'console.log(JSON.stringify({',
        '  schemaVersion: 1,',
        '  connection: {',
        "    type: 'ssh',",
        "    projectRoot: '/workspace/repo',",
        '    target: {',
        "      label: 'Sandbox',",
        "      host: 'sandbox.example.com',",
        '      port: 22,',
        "      username: 'root'",
        '    }',
        '  }',
        '}))'
      ].join('\n')
    )
    writeFileSync(destroyPath, 'process.exit(1)')
    writeFileSync(
      join(repoPath, 'orca.yaml'),
      [
        'environmentRecipes:',
        '  - id: cloud-sandbox',
        '    name: Cloud Sandbox',
        `    create: ${JSON.stringify(nodeCommand(startPath))}`,
        `    destroy: ${JSON.stringify(nodeCommand(destroyPath))}`
      ].join('\n')
    )

    registerEphemeralVmHandlers(makeStore(repoPath) as never)
    const provisioned = (await handlers.get('ephemeralVm:provision')?.(null, {
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox'
    } as never)) as { ok: true; runtime: { id: string } }

    const cleaned = (await handlers.get('ephemeralVm:cleanup')?.(null, {
      runtimeId: provisioned.runtime.id
    } as never)) as {
      status?: string
      cleanupLastError?: string
      connectionMode?: string
      sshTargetId?: string
    }

    expect(cleaned).toEqual(expect.objectContaining({ status: 'cleanup_failed' }))
    expect(cleaned.cleanupLastError).toBeTruthy()
    expect(removeRuntimeOwnedSshTargetMock).not.toHaveBeenCalled()
    expect(cleaned.connectionMode).toBe('ssh')
    expect(cleaned.sshTargetId).toBe('runtime-ssh-orca-instance-1')
  })

  it('runs suspend and resume for an attached ephemeral VM workspace', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-ipc-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-ipc-repo-')
    getPathMock.mockReturnValue(userDataPath)
    mkdirSync(join(repoPath, 'scripts'), { recursive: true })
    const startPath = join(repoPath, 'scripts', 'start.js')
    const suspendPath = join(repoPath, 'scripts', 'suspend.js')
    const resumePath = join(repoPath, 'scripts', 'resume.js')
    const resumedPairingCode = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'wss://resumed.example.com',
      deviceToken: 'resumed-token',
      publicKeyB64: 'resumed-public-key'
    })
    writeFileSync(
      startPath,
      [
        'console.log(JSON.stringify({',
        '  schemaVersion: 1,',
        `  pairingCode: ${JSON.stringify(makePairingCode())},`,
        "  projectRoot: '/workspace/repo'",
        '}))'
      ].join('\n')
    )
    writeFileSync(
      suspendPath,
      [
        "const fs = require('fs')",
        "const payload = JSON.parse(fs.readFileSync(0, 'utf8'))",
        "fs.writeFileSync('suspend-mode.txt', payload.mode)"
      ].join('\n')
    )
    writeFileSync(
      resumePath,
      [
        "const fs = require('fs')",
        "const payload = JSON.parse(fs.readFileSync(0, 'utf8'))",
        'if (payload.mode !== "resume") process.exit(2)',
        "fs.writeFileSync('resume-mode.txt', payload.mode)",
        'console.log(JSON.stringify({',
        '  schemaVersion: 1,',
        `  pairingCode: ${JSON.stringify(resumedPairingCode)},`,
        "  projectRoot: '/workspace/resumed'",
        '}))'
      ].join('\n')
    )
    writeFileSync(
      join(repoPath, 'orca.yaml'),
      [
        'environmentRecipes:',
        '  - id: cloud-sandbox',
        '    name: Cloud Sandbox',
        `    create: ${JSON.stringify(nodeCommand(startPath))}`,
        `    suspend: ${JSON.stringify(nodeCommand(suspendPath))}`,
        `    resume: ${JSON.stringify(nodeCommand(resumePath))}`,
        '    destroy: none'
      ].join('\n')
    )

    const store = makeStore(repoPath)
    registerEphemeralVmHandlers(store as never)
    const provisioned = (await handlers.get('ephemeralVm:provision')?.(null, {
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox'
    } as never)) as { ok: true; runtime: { id: string }; environment: { id: string } }
    await handlers.get('ephemeralVm:attachWorkspace')?.(null, {
      runtimeId: provisioned.runtime.id,
      workspaceId: 'workspace-1'
    } as never)

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resume reads only getRepo and getRepos, which makeStore provides.
    const runningResume = await resumeEphemeralVmWorkspace(store as never, 'workspace-1', {
      sshHeld: false,
      sshUserDisconnects: 0
    })
    expect(runningResume).toEqual(expect.objectContaining({ status: 'running' }))
    expect(existsSync(join(repoPath, 'resume-mode.txt'))).toBe(false)

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the suspend reads only getRepo and getRepos, which makeStore provides.
    await suspendEphemeralVmWorkspace(store as never, 'workspace-1')
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([
      expect.objectContaining({ status: 'suspended' })
    ])
    expect(readFileSync(join(repoPath, 'suspend-mode.txt'), 'utf8')).toBe('suspend')

    invalidateRuntimeEnvironmentTransportMock.mockImplementationOnce((environmentId: string) => {
      const environment = listEnvironments(userDataPath).find((entry) => entry.id === environmentId)
      expect(environment?.endpoints[0]?.endpoint).toBe('wss://resumed.example.com')
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resume reads only getRepo and getRepos, which makeStore provides.
    const resumed = await resumeEphemeralVmWorkspace(store as never, 'workspace-1', {
      sshHeld: false,
      sshUserDisconnects: 0
    })
    expect(resumed).toEqual(
      expect.objectContaining({
        status: 'running',
        recipeResult: expect.objectContaining({ projectRoot: '/workspace/resumed' })
      })
    )
    expect(readFileSync(join(repoPath, 'resume-mode.txt'), 'utf8')).toBe('resume')
    const environment = listEnvironments(userDataPath).find(
      (entry) => entry.id === provisioned.environment.id
    )
    expect(environment?.endpoints[0]?.endpoint).toBe('wss://resumed.example.com')
    expect(invalidateRuntimeEnvironmentTransportMock).toHaveBeenCalledWith(
      provisioned.environment.id
    )
  })

  it('redacts recipe stdout when provisioning fails', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-ipc-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-ipc-repo-')
    getPathMock.mockReturnValue(userDataPath)
    mkdirSync(join(repoPath, 'scripts'), { recursive: true })
    const startPath = join(repoPath, 'scripts', 'start.js')
    writeFileSync(
      startPath,
      [
        'console.log(JSON.stringify({',
        `  pairingCode: ${JSON.stringify(makePairingCode())},`,
        "  token: 'provider-token'",
        '}))'
      ].join('\n')
    )
    writeFileSync(
      join(repoPath, 'orca.yaml'),
      [
        'environmentRecipes:',
        '  - id: cloud-sandbox',
        '    name: Cloud Sandbox',
        `    create: ${JSON.stringify(nodeCommand(startPath))}`,
        '    destroy: none'
      ].join('\n')
    )

    registerEphemeralVmHandlers(makeStore(repoPath) as never)
    const result = (await handlers.get('ephemeralVm:provision')?.(null, {
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox'
    } as never)) as { ok: false; stdout: string }

    expect(result.ok).toBe(false)
    expect(result.stdout).toContain('"pairingCode":"[redacted]"')
    expect(result.stdout).toContain('"token":"[redacted]"')
    expect(result.stdout).not.toContain('provider-token')
    expect(result.stdout).not.toContain('public-key')
  })
})
