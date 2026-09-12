import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { upsertEphemeralVmRuntime } from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'

const handlers = new Map<string, (_event: unknown, args: never) => unknown>()
const {
  handleMock,
  removeHandlerMock,
  getPathMock,
  connectRegisteredSshTargetMock,
  getSshConnectionStoreMock,
  upsertRuntimeOwnedTargetMock,
  disconnectRegisteredSshTargetMock,
  removeRegisteredSshTargetMock,
  getSshGitProviderMock,
  getSshFilesystemProviderMock,
  getSshPtyProviderMock,
  invalidateRuntimeEnvironmentTransportMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  getPathMock: vi.fn(),
  connectRegisteredSshTargetMock: vi.fn(),
  getSshConnectionStoreMock: vi.fn(),
  upsertRuntimeOwnedTargetMock: vi.fn(),
  disconnectRegisteredSshTargetMock: vi.fn(),
  removeRegisteredSshTargetMock: vi.fn(),
  getSshGitProviderMock: vi.fn(),
  getSshFilesystemProviderMock: vi.fn(),
  getSshPtyProviderMock: vi.fn(),
  invalidateRuntimeEnvironmentTransportMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: getPathMock },
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

// The real ephemeral-vm-runtime-ssh module runs; only the SSH stack under it is stubbed,
// so these cases exercise the handler → ensure → provider-registry path end to end.
vi.mock('./ssh', () => ({
  connectRegisteredSshTarget: connectRegisteredSshTargetMock,
  getSshConnectionStore: getSshConnectionStoreMock
}))

vi.mock('./ssh-session-teardown', () => ({
  disconnectRegisteredSshTarget: disconnectRegisteredSshTargetMock,
  removeRegisteredSshTarget: removeRegisteredSshTargetMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: getSshFilesystemProviderMock
}))

vi.mock('./pty/provider/registry', () => ({
  getSshPtyProvider: getSshPtyProviderMock
}))

vi.mock('./runtime-environments', () => ({
  invalidateRuntimeEnvironmentTransport: invalidateRuntimeEnvironmentTransportMock
}))

import { registerEphemeralVmRuntimeHandlers } from './ephemeral-vm-runtime-handlers'

const TARGET_ID = 'runtime-ssh-instance-1'
const tempDirs: string[] = []

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeStore(repoPath: string) {
  const repo = {
    id: 'repo-1',
    path: repoPath,
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 0
  }
  return {
    getRepo: vi.fn((repoId: string) => (repoId === 'repo-1' ? repo : null)),
    getRepos: vi.fn(() => [repo]),
    getSettings: vi.fn(() => ({ activeRuntimeEnvironmentId: null })),
    updateSettings: vi.fn()
  }
}

/** A script that records that it ran, so a test can prove the recipe was not re-run. */
function markerScript(repoPath: string, name: string): string {
  const scriptPath = join(repoPath, 'scripts', `${name}.js`)
  mkdirSync(join(repoPath, 'scripts'), { recursive: true })
  writeFileSync(
    scriptPath,
    [
      "const fs = require('fs')",
      "process.stdin.resume().on('data', () => {})",
      `fs.writeFileSync(${JSON.stringify(join(repoPath, `${name}-ran.txt`))}, 'ran')`,
      'console.log(JSON.stringify({',
      '  schemaVersion: 1,',
      '  connection: {',
      "    type: 'ssh',",
      "    projectRoot: '/workspace/repo',",
      "    target: { label: 'Agent Sandbox', host: '127.0.0.1', port: 2222, username: 'orca' }",
      '  }',
      '}))'
    ].join('\n')
  )
  return `"${process.execPath}" "${scriptPath}"`
}

function seedRuntime(
  userDataPath: string,
  overrides: Partial<EphemeralVmRuntimeRecord> & {
    recipe: EphemeralVmRuntimeRecord['recipe']
  }
): void {
  upsertEphemeralVmRuntime(userDataPath, {
    id: 'instance-1',
    recipeId: 'agent-sandbox',
    repoId: 'repo-1',
    workspaceId: 'workspace-1',
    status: 'running',
    cleanupStatus: 'not_started',
    connectionMode: 'ssh',
    sshTargetId: TARGET_ID,
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 1,
      connection: {
        type: 'ssh',
        projectRoot: '/workspace/repo',
        target: { label: 'Agent Sandbox', host: '127.0.0.1', port: 2222, username: 'orca' }
      }
    },
    ...overrides
  })
}

describe('runtime-owned SSH rehydration on workspace activation (#19173)', () => {
  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: never) => {
      handlers.set(channel, handler)
    })
    removeHandlerMock.mockReset()
    getPathMock.mockReset()
    connectRegisteredSshTargetMock.mockReset()
    connectRegisteredSshTargetMock.mockResolvedValue({ status: 'connected' })
    upsertRuntimeOwnedTargetMock.mockReset()
    upsertRuntimeOwnedTargetMock.mockImplementation((runtimeId: string) => ({
      id: `runtime-ssh-${runtimeId}`
    }))
    getSshConnectionStoreMock.mockReset()
    getSshConnectionStoreMock.mockReturnValue({
      upsertRuntimeOwnedTarget: upsertRuntimeOwnedTargetMock
    })
    disconnectRegisteredSshTargetMock.mockReset()
    disconnectRegisteredSshTargetMock.mockResolvedValue(undefined)
    removeRegisteredSshTargetMock.mockReset()
    removeRegisteredSshTargetMock.mockResolvedValue(undefined)
    getSshGitProviderMock.mockReset()
    getSshGitProviderMock.mockReturnValue({})
    getSshFilesystemProviderMock.mockReset()
    getSshFilesystemProviderMock.mockReturnValue({})
    getSshPtyProviderMock.mockReset()
    // The relay registers all three providers together, so the provider appears once connect lands.
    getSshPtyProviderMock.mockImplementation(() =>
      connectRegisteredSshTargetMock.mock.calls.length > 0 ? {} : undefined
    )
    invalidateRuntimeEnvironmentTransportMock.mockReset()
  })

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reconnects a persisted running runtime without re-running the resume recipe', async () => {
    const userDataPath = makeDir('orca-rehydrate-user-data-')
    const repoPath = makeDir('orca-rehydrate-repo-')
    getPathMock.mockReturnValue(userDataPath)
    const resumeCommand = markerScript(repoPath, 'resume')
    seedRuntime(userDataPath, {
      status: 'running',
      recipe: {
        id: 'agent-sandbox',
        name: 'Agent Sandbox',
        create: 'noop',
        resume: resumeCommand
      }
    })
    registerEphemeralVmRuntimeHandlers(makeStore(repoPath) as never)

    const resumed = await handlers.get('ephemeralVm:resumeWorkspace')?.(null, {
      workspaceId: 'workspace-1'
    } as never)

    expect(connectRegisteredSshTargetMock).toHaveBeenCalledWith(TARGET_ID)
    // The sandbox never stopped; only this process lost its transport.
    expect(existsSync(join(repoPath, 'resume-ran.txt'))).toBe(false)
    expect(resumed).toEqual(expect.objectContaining({ status: 'running' }))
  })

  it('reconnects the transport when the recipe has no resume command to run', async () => {
    const userDataPath = makeDir('orca-rehydrate-skip-user-data-')
    const repoPath = makeDir('orca-rehydrate-skip-repo-')
    getPathMock.mockReturnValue(userDataPath)
    seedRuntime(userDataPath, {
      status: 'suspended',
      recipe: { id: 'agent-sandbox', name: 'Agent Sandbox', create: 'noop' }
    })
    registerEphemeralVmRuntimeHandlers(makeStore(repoPath) as never)

    const resumed = await handlers.get('ephemeralVm:resumeWorkspace')?.(null, {
      workspaceId: 'workspace-1'
    } as never)

    expect(connectRegisteredSshTargetMock).toHaveBeenCalledWith(TARGET_ID)
    expect(resumed).toEqual(expect.objectContaining({ status: 'running' }))
  })

  it('does not dial a runtime whose provisioning failed', async () => {
    // Why: activating a failed runtime used to be inert; it must not start raising connection
    // errors for a sandbox that was never up.
    const userDataPath = makeDir('orca-rehydrate-failed-user-data-')
    const repoPath = makeDir('orca-rehydrate-failed-repo-')
    getPathMock.mockReturnValue(userDataPath)
    seedRuntime(userDataPath, {
      status: 'failed',
      recipe: { id: 'agent-sandbox', name: 'Agent Sandbox', create: 'noop' }
    })
    registerEphemeralVmRuntimeHandlers(makeStore(repoPath) as never)

    const resumed = await handlers.get('ephemeralVm:resumeWorkspace')?.(null, {
      workspaceId: 'workspace-1'
    } as never)

    expect(connectRegisteredSshTargetMock).not.toHaveBeenCalled()
    expect(resumed).toEqual(expect.objectContaining({ status: 'failed' }))
  })

  it('does not redial a runtime whose PTY provider is still registered', async () => {
    const userDataPath = makeDir('orca-rehydrate-live-user-data-')
    const repoPath = makeDir('orca-rehydrate-live-repo-')
    getPathMock.mockReturnValue(userDataPath)
    // A live relay session in this process already owns the target.
    getSshPtyProviderMock.mockReturnValue({})
    seedRuntime(userDataPath, {
      status: 'running',
      recipe: { id: 'agent-sandbox', name: 'Agent Sandbox', create: 'noop', resume: 'noop' }
    })
    registerEphemeralVmRuntimeHandlers(makeStore(repoPath) as never)

    const resumed = await handlers.get('ephemeralVm:resumeWorkspace')?.(null, {
      workspaceId: 'workspace-1'
    } as never)

    expect(connectRegisteredSshTargetMock).not.toHaveBeenCalled()
    expect(disconnectRegisteredSshTargetMock).not.toHaveBeenCalled()
    expect(resumed).toEqual(expect.objectContaining({ status: 'running' }))
  })
})
