import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { listEnvironments } from '../../shared/runtime-environment-store'

const handlers = new Map<string, (_event: unknown, args: never) => Promise<unknown> | unknown>()
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

vi.mock('../ephemeral-vm-runtime-ssh', () => ({
  connectRuntimeOwnedSshTarget: connectRuntimeOwnedSshTargetMock,
  disconnectRuntimeOwnedSshTarget: disconnectRuntimeOwnedSshTargetMock,
  removeRuntimeOwnedSshTarget: removeRuntimeOwnedSshTargetMock
}))

vi.mock('./runtime-environments', () => ({
  invalidateRuntimeEnvironmentTransport: invalidateRuntimeEnvironmentTransportMock
}))

import { registerEphemeralVmHandlers } from './ephemeral-vm'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
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

describe('registerEphemeralVmHandlers', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
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

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('lists recipes from local repo orca.yaml', async () => {
    const repoPath = makeDir('orca-ephemeral-vm-ipc-repo-')
    writeFileSync(
      join(repoPath, 'orca.yaml'),
      [
        'environmentRecipes:',
        '  - id: cloud-sandbox',
        '    name: Cloud Sandbox',
        '    create: ./scripts/start.sh',
        '    destroy: none'
      ].join('\n')
    )

    const store = makeStore(repoPath)
    registerEphemeralVmHandlers(store as never)
    const result = await handlers.get('ephemeralVm:listRecipes')?.(null, {
      repoId: 'repo-1'
    } as never)

    expect(removeHandlerMock).toHaveBeenCalledWith('ephemeralVm:listRecipes')
    expect(result).toEqual({
      status: 'ok',
      repoPath,
      diagnostics: [],
      recipes: [
        {
          id: 'cloud-sandbox',
          name: 'Cloud Sandbox',
          create: './scripts/start.sh',
          destroyDisabled: true
        }
      ]
    })
  })

  it('lists the recipe catalog across local git repos', async () => {
    const repoPath = makeDir('orca-ephemeral-vm-ipc-repo-')
    writeFileSync(
      join(repoPath, 'orca.yaml'),
      [
        'environmentRecipes:',
        '  - id: cloud-sandbox',
        '    name: Cloud Sandbox',
        '    create: ./scripts/start.sh',
        '    destroy: none'
      ].join('\n')
    )

    const store = makeStore(repoPath)
    registerEphemeralVmHandlers(store as never)
    const result = await handlers.get('ephemeralVm:listRecipeCatalog')?.(null, undefined as never)

    expect(result).toEqual([
      {
        repoId: 'repo-1',
        repoName: 'Repo',
        repoPath,
        diagnostics: [],
        recipes: [
          {
            id: 'cloud-sandbox',
            name: 'Cloud Sandbox',
            create: './scripts/start.sh',
            destroyDisabled: true
          }
        ]
      }
    ])
  })

  it('provisions a recipe and persists the ephemeral runtime', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-ipc-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-ipc-repo-')
    getPathMock.mockReturnValue(userDataPath)
    mkdirSync(join(repoPath, 'scripts'), { recursive: true })
    const startPath = join(repoPath, 'scripts', 'start.js')
    writeFileSync(
      startPath,
      [
        'console.log(JSON.stringify({',
        '  schemaVersion: 1,',
        `  pairingCode: ${JSON.stringify(makePairingCode())},`,
        "  projectRoot: '/workspace/repo',",
        '  userData: { providerResourceId: process.env.ORCA_VM_INSTANCE_ID }',
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

    const store = makeStore(repoPath)
    registerEphemeralVmHandlers(store as never)
    const result = (await handlers.get('ephemeralVm:provision')?.(null, {
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      workspaceName: 'Fix Login Race'
    } as never)) as {
      ok: boolean
      runtime?: { id: string; repoId?: string; status?: string; runtimeEnvironmentId?: string }
      environment?: { id: string; name: string }
    }

    expect(result).toMatchObject({
      ok: true,
      environment: {
        name: expect.stringContaining('Repo VM ')
      },
      runtime: {
        repoId: 'repo-1',
        status: 'running',
        runtimeEnvironmentId: result.environment?.id
      }
    })
    const runtimes = await handlers.get('ephemeralVm:listRuntimes')?.(null, undefined as never)
    expect(runtimes).toEqual([
      expect.objectContaining({
        repoId: 'repo-1',
        recipeId: 'cloud-sandbox',
        runtimeEnvironmentId: result.environment?.id
      })
    ])

    const attached = await handlers.get('ephemeralVm:attachWorkspace')?.(null, {
      runtimeId: result.runtime?.id,
      workspaceId: 'repo-1::/workspace/repo/worktree'
    } as never)
    expect(attached).toEqual(
      expect.objectContaining({
        id: result.runtime?.id,
        workspaceId: 'repo-1::/workspace/repo/worktree'
      })
    )

    store.updateSettings({ activeRuntimeEnvironmentId: result.environment!.id })
    const cleaned = await handlers.get('ephemeralVm:cleanup')?.(null, {
      runtimeId: result.runtime?.id
    } as never)
    expect(cleaned).toEqual(expect.objectContaining({ status: 'cleaned' }))
    expect(listEnvironments(userDataPath)).toEqual([])
    expect(store.updateSettings).toHaveBeenLastCalledWith(
      { activeRuntimeEnvironmentId: null },
      { notifyListeners: true }
    )
  })

  it('provisions an ssh recipe without creating a runtime environment', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-ipc-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-ipc-repo-')
    getPathMock.mockReturnValue(userDataPath)
    mkdirSync(join(repoPath, 'scripts'), { recursive: true })
    const startPath = join(repoPath, 'scripts', 'start-ssh.js')
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
        '  },',
        "  userData: { sandboxId: 'sandbox-123' }",
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
      recipeId: 'cloud-sandbox',
      workspaceName: 'Fix Login Race'
    } as never)) as {
      ok: boolean
      connectionType?: string
      sshTargetId?: string
      runtime?: {
        id: string
        repoId?: string
        status?: string
        connectionMode?: string
        sshTargetId?: string
      }
      environment?: { id: string; name: string }
    }

    expect(result).toMatchObject({
      ok: true,
      connectionType: 'ssh',
      sshTargetId: 'runtime-ssh-orca-instance-1',
      runtime: {
        repoId: 'repo-1',
        status: 'running',
        connectionMode: 'ssh',
        sshTargetId: 'runtime-ssh-orca-instance-1'
      }
    })
    expect(result.environment).toBeUndefined()
    expect(connectRuntimeOwnedSshTargetMock).toHaveBeenCalledWith({
      runtimeId: result.runtime?.id,
      connection: {
        type: 'ssh',
        projectRoot: '/workspace/repo',
        target: {
          label: 'Sandbox',
          host: 'sandbox.example.com',
          port: 22,
          username: 'root'
        }
      }
    })
    expect(listEnvironments(userDataPath)).toEqual([])
  })

  it('removes the runtime-owned SSH target on cleanup even when destroy fails', async () => {
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
    // Why: a failing destroy drives the cleanup_failed branch; the runtime-owned
    // SSH target must still be torn down so it never orphans (see Fix D).
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
    } as never)) as { status?: string; connectionMode?: string; sshTargetId?: string }

    expect(cleaned).toEqual(expect.objectContaining({ status: 'cleanup_failed' }))
    expect(removeRuntimeOwnedSshTargetMock).toHaveBeenCalledWith('runtime-ssh-orca-instance-1')
    expect(cleaned.connectionMode).toBeUndefined()
    expect(cleaned.sshTargetId).toBeUndefined()
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

    registerEphemeralVmHandlers(makeStore(repoPath) as never)
    const provisioned = (await handlers.get('ephemeralVm:provision')?.(null, {
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox'
    } as never)) as { ok: true; runtime: { id: string }; environment: { id: string } }
    await handlers.get('ephemeralVm:attachWorkspace')?.(null, {
      runtimeId: provisioned.runtime.id,
      workspaceId: 'workspace-1'
    } as never)

    const runningResume = await handlers.get('ephemeralVm:resumeWorkspace')?.(null, {
      workspaceId: 'workspace-1'
    } as never)
    expect(runningResume).toEqual(expect.objectContaining({ status: 'running' }))
    expect(existsSync(join(repoPath, 'resume-mode.txt'))).toBe(false)

    const suspended = await handlers.get('ephemeralVm:suspendWorkspace')?.(null, {
      workspaceId: 'workspace-1'
    } as never)
    expect(suspended).toEqual(expect.objectContaining({ status: 'suspended' }))
    expect(readFileSync(join(repoPath, 'suspend-mode.txt'), 'utf8')).toBe('suspend')

    invalidateRuntimeEnvironmentTransportMock.mockImplementationOnce((environmentId: string) => {
      const environment = listEnvironments(userDataPath).find((entry) => entry.id === environmentId)
      expect(environment?.endpoints[0]?.endpoint).toBe('wss://resumed.example.com')
    })
    const resumed = await handlers.get('ephemeralVm:resumeWorkspace')?.(null, {
      workspaceId: 'workspace-1'
    } as never)
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

  it('returns a copyable cleanup command for a persisted runtime', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-ipc-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-ipc-repo-')
    getPathMock.mockReturnValue(userDataPath)
    mkdirSync(join(repoPath, 'scripts'), { recursive: true })
    const startPath = join(repoPath, 'scripts', 'start.js')
    const cleanupPath = join(repoPath, 'scripts', 'cleanup.js')
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
    writeFileSync(cleanupPath, 'process.stdin.resume()\n')
    writeFileSync(
      join(repoPath, 'orca.yaml'),
      [
        'environmentRecipes:',
        '  - id: cloud-sandbox',
        '    name: Cloud Sandbox',
        `    create: ${JSON.stringify(nodeCommand(startPath))}`,
        `    destroy: ${JSON.stringify(nodeCommand(cleanupPath))}`
      ].join('\n')
    )

    registerEphemeralVmHandlers(makeStore(repoPath) as never)
    const provisioned = (await handlers.get('ephemeralVm:provision')?.(null, {
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      workspaceName: 'Fix Login Race'
    } as never)) as { ok: true; runtime: { id: string } }
    const result = await handlers.get('ephemeralVm:getCleanupCommand')?.(null, {
      runtimeId: provisioned.runtime.id
    } as never)

    expect(result).toMatchObject({
      runtimeId: provisioned.runtime.id,
      cleanupDisabled: false,
      payloadJson: expect.stringContaining('"workspaceName": "Fix Login Race"'),
      command: expect.stringContaining(nodeCommand(cleanupPath))
    })
  })

  it('streams provision logs and cancels an active provision', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-ipc-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-ipc-repo-')
    getPathMock.mockReturnValue(userDataPath)
    mkdirSync(join(repoPath, 'scripts'), { recursive: true })
    const startPath = join(repoPath, 'scripts', 'start.js')
    writeFileSync(
      startPath,
      [
        "process.stderr.write('creating sandbox\\n')",
        'setTimeout(() => {',
        '  console.log(JSON.stringify({',
        '    schemaVersion: 1,',
        `    pairingCode: ${JSON.stringify(makePairingCode())},`,
        "    projectRoot: '/workspace/repo'",
        '  }))',
        '}, 30000)'
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
    const sender = { send: vi.fn() }
    const provision = handlers.get('ephemeralVm:provision')?.({ sender }, {
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      workspaceName: 'Fix Login Race',
      provisionId: 'provision-1'
    } as never) as Promise<{ ok: boolean; error?: string }>

    await vi.waitFor(() =>
      expect(sender.send).toHaveBeenCalledWith('ephemeralVm:provisionEvent', {
        provisionId: 'provision-1',
        stream: 'stderr',
        chunk: 'creating sandbox\n'
      })
    )
    const cancelled = await handlers.get('ephemeralVm:cancelProvision')?.(null, {
      provisionId: 'provision-1'
    } as never)
    const result = await provision

    expect(cancelled).toEqual({ cancelled: true })
    expect(result.ok).toBe(false)
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
