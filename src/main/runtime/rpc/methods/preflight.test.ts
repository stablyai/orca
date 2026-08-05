import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { PREFLIGHT_METHODS } from './preflight'

const {
  detectInstalledAgentCommandsWithShellPathHydrationMock,
  detectInstalledAgentInventoryWithShellPathHydrationMock,
  detectInstalledAgentsWithShellPathHydrationMock,
  detectRemoteAgentInventoryMock,
  detectRemoteAgentsMock,
  detectRemoteWindowsTerminalCapabilitiesMock,
  refreshShellPathAndDetectAgentsMock,
  runPreflightCheckMock
} = vi.hoisted(() => ({
  detectInstalledAgentCommandsWithShellPathHydrationMock: vi.fn(),
  detectInstalledAgentInventoryWithShellPathHydrationMock: vi.fn(),
  detectInstalledAgentsWithShellPathHydrationMock: vi.fn(),
  detectRemoteAgentInventoryMock: vi.fn(),
  detectRemoteAgentsMock: vi.fn(),
  detectRemoteWindowsTerminalCapabilitiesMock: vi.fn(),
  refreshShellPathAndDetectAgentsMock: vi.fn(),
  runPreflightCheckMock: vi.fn()
}))

vi.mock('../../../ipc/preflight', () => ({
  detectInstalledAgentCommandsWithShellPathHydration:
    detectInstalledAgentCommandsWithShellPathHydrationMock,
  detectInstalledAgentInventoryWithShellPathHydration:
    detectInstalledAgentInventoryWithShellPathHydrationMock,
  detectInstalledAgentsWithShellPathHydration: detectInstalledAgentsWithShellPathHydrationMock,
  detectRemoteAgentInventory: detectRemoteAgentInventoryMock,
  detectRemoteAgents: detectRemoteAgentsMock,
  detectRemoteWindowsTerminalCapabilities: detectRemoteWindowsTerminalCapabilitiesMock,
  refreshShellPathAndDetectAgents: refreshShellPathAndDetectAgentsMock,
  runPreflightCheck: runPreflightCheckMock
}))

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('preflight RPC methods', () => {
  it('runs the server-side preflight check through runtime RPC', async () => {
    const status = {
      git: { installed: true },
      gh: { installed: true, authenticated: true },
      glab: { installed: false, authenticated: false },
      bitbucket: { configured: false, authenticated: false, account: null }
    }
    runPreflightCheckMock.mockResolvedValueOnce(status)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: PREFLIGHT_METHODS })

    const response = await dispatcher.dispatch(makeRequest('preflight.check', { force: true }))

    expect(runPreflightCheckMock).toHaveBeenCalledWith(true)
    expect(response).toMatchObject({ ok: true, result: status })
  })

  it('detects agents and refreshes PATH on the server through runtime RPC', async () => {
    detectInstalledAgentsWithShellPathHydrationMock.mockResolvedValueOnce(['codex'])
    refreshShellPathAndDetectAgentsMock.mockResolvedValueOnce({
      agents: ['codex', 'claude'],
      addedPathSegments: ['/opt/bin'],
      shellHydrationOk: true,
      pathSource: 'shell_hydrate',
      pathFailureReason: 'none'
    })
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: PREFLIGHT_METHODS })

    const detected = await dispatcher.dispatch(makeRequest('preflight.detectAgents'))
    const refreshed = await dispatcher.dispatch(makeRequest('preflight.refreshAgents'))

    expect(detectInstalledAgentsWithShellPathHydrationMock).toHaveBeenCalled()
    expect(refreshShellPathAndDetectAgentsMock).toHaveBeenCalled()
    expect(detected).toMatchObject({ ok: true, result: ['codex'] })
    expect(refreshed).toMatchObject({
      ok: true,
      result: { agents: ['codex', 'claude'], shellHydrationOk: true }
    })
  })

  it('preserves matched commands through the versioned runtime inventory methods', async () => {
    const localInventory = {
      version: 1,
      agents: ['cursor'],
      matchedCommands: { cursor: 'cursor agent' }
    }
    const remoteInventory = {
      version: 1,
      agents: ['cursor'],
      matchedCommands: { cursor: 'cursor-agent' }
    }
    detectInstalledAgentInventoryWithShellPathHydrationMock.mockResolvedValueOnce(localInventory)
    detectRemoteAgentInventoryMock.mockResolvedValueOnce(remoteInventory)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: PREFLIGHT_METHODS })

    await expect(
      dispatcher.dispatch(makeRequest('preflight.detectAgentInventory', { wslDistro: 'Ubuntu' }))
    ).resolves.toMatchObject({ ok: true, result: localInventory })
    await expect(
      dispatcher.dispatch(
        makeRequest('preflight.detectRemoteAgentInventory', { connectionId: 'ssh-1' })
      )
    ).resolves.toMatchObject({ ok: true, result: remoteInventory })
    expect(detectInstalledAgentInventoryWithShellPathHydrationMock).toHaveBeenCalledWith({
      wslDistro: 'Ubuntu'
    })
    expect(detectRemoteAgentInventoryMock).toHaveBeenCalledWith({ connectionId: 'ssh-1' })
  })

  it('keeps no-params inventory requests backward compatible', async () => {
    detectInstalledAgentInventoryWithShellPathHydrationMock.mockResolvedValueOnce({
      version: 1,
      agents: [],
      matchedCommands: {}
    })
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: PREFLIGHT_METHODS })

    await expect(
      dispatcher.dispatch(makeRequest('preflight.detectAgentInventory'))
    ).resolves.toMatchObject({ ok: true })
    expect(detectInstalledAgentInventoryWithShellPathHydrationMock).toHaveBeenCalledWith({})
  })

  it('forwards WSL context through every local agent detection method', async () => {
    detectInstalledAgentsWithShellPathHydrationMock.mockResolvedValueOnce(['cursor'])
    detectInstalledAgentCommandsWithShellPathHydrationMock.mockResolvedValueOnce({
      agents: ['cursor'],
      matchedCommands: { cursor: 'cursor-agent' }
    })
    refreshShellPathAndDetectAgentsMock.mockResolvedValueOnce({
      agents: ['cursor'],
      matchedCommands: { cursor: 'cursor-agent' },
      addedPathSegments: [],
      shellHydrationOk: true,
      pathSource: 'sync_seed_only',
      pathFailureReason: 'none'
    })
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: PREFLIGHT_METHODS })
    const context = { wslDistro: 'Ubuntu' }

    await expect(
      dispatcher.dispatch(makeRequest('preflight.detectAgents', context))
    ).resolves.toMatchObject({ ok: true, result: ['cursor'] })
    await expect(
      dispatcher.dispatch(makeRequest('preflight.detectAgentCommands', context))
    ).resolves.toMatchObject({ ok: true, result: { agents: ['cursor'] } })
    await expect(
      dispatcher.dispatch(makeRequest('preflight.refreshAgents', context))
    ).resolves.toMatchObject({ ok: true, result: { agents: ['cursor'] } })
    expect(detectInstalledAgentsWithShellPathHydrationMock).toHaveBeenLastCalledWith(context)
    expect(detectInstalledAgentCommandsWithShellPathHydrationMock).toHaveBeenLastCalledWith(context)
    expect(refreshShellPathAndDetectAgentsMock).toHaveBeenLastCalledWith(context)
  })

  it('detects agents on remote SSH connections through runtime RPC', async () => {
    detectRemoteAgentsMock.mockResolvedValueOnce(['claude'])
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: PREFLIGHT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('preflight.detectRemoteAgents', { connectionId: 'ssh-1' })
    )

    expect(detectRemoteAgentsMock).toHaveBeenCalledWith({ connectionId: 'ssh-1' })
    expect(response).toMatchObject({ ok: true, result: ['claude'] })
  })

  it('detects remote Windows terminal capabilities through runtime RPC', async () => {
    detectRemoteWindowsTerminalCapabilitiesMock.mockResolvedValueOnce({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: true,
      hostPlatform: 'win32'
    })
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: PREFLIGHT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('preflight.detectRemoteWindowsTerminalCapabilities', {
        connectionId: 'ssh-1'
      })
    )

    expect(detectRemoteWindowsTerminalCapabilitiesMock).toHaveBeenCalledWith({
      connectionId: 'ssh-1'
    })
    expect(response).toMatchObject({
      ok: true,
      result: {
        wslAvailable: true,
        wslDistros: ['Ubuntu'],
        pwshAvailable: true,
        gitBashAvailable: true,
        hostPlatform: 'win32'
      }
    })
  })
})
