import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDirs } from '../../shared/testing/remove-temp-dirs.test-support'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/remote-runtime/pairing/pairing'
import { PAIRING_OFFER_VERSION } from '../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'

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
  BrowserWindow: { getAllWindows: () => [] },
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
})
