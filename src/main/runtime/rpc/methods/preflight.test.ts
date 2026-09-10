import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { PREFLIGHT_METHODS } from './preflight'

const {
  detectInstalledAgentsWithShellPathHydrationMock,
  detectRemoteAgentsMock,
  detectRemoteWindowsTerminalCapabilitiesMock,
  refreshShellPathAndDetectAgentsMock,
  runPreflightCheckMock
} = vi.hoisted(() => ({
  detectInstalledAgentsWithShellPathHydrationMock: vi.fn(),
  detectRemoteAgentsMock: vi.fn(),
  detectRemoteWindowsTerminalCapabilitiesMock: vi.fn(),
  refreshShellPathAndDetectAgentsMock: vi.fn(),
  runPreflightCheckMock: vi.fn()
}))

vi.mock('../../../preflight/agent-detection', () => ({
  detectInstalledAgentsWithShellPathHydration: detectInstalledAgentsWithShellPathHydrationMock,
  detectRemoteAgents: detectRemoteAgentsMock,
  detectRemoteWindowsTerminalCapabilities: detectRemoteWindowsTerminalCapabilitiesMock,
  refreshShellPathAndDetectAgents: refreshShellPathAndDetectAgentsMock,
  runPreflightCheck: runPreflightCheckMock
}))

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('preflight RPC methods', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

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

    expect(detectInstalledAgentsWithShellPathHydrationMock).toHaveBeenCalledWith(undefined)
    expect(refreshShellPathAndDetectAgentsMock).toHaveBeenCalledWith(undefined)
    expect(detected).toMatchObject({ ok: true, result: ['codex'] })
    expect(refreshed).toMatchObject({
      ok: true,
      result: { agents: ['codex', 'claude'], shellHydrationOk: true }
    })
  })

  it('detects agents inside the WSL distro the request names', async () => {
    detectInstalledAgentsWithShellPathHydrationMock.mockResolvedValueOnce(['claude'])
    refreshShellPathAndDetectAgentsMock.mockResolvedValueOnce({
      agents: ['claude'],
      addedPathSegments: [],
      shellHydrationOk: true,
      pathSource: 'shell_hydrate',
      pathFailureReason: 'none'
    })
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: PREFLIGHT_METHODS })

    const detected = await dispatcher.dispatch(
      makeRequest('preflight.detectAgents', { wslDistro: 'Ubuntu-24.04' })
    )
    await dispatcher.dispatch(makeRequest('preflight.refreshAgents', { wslDefault: true }))

    expect(detectInstalledAgentsWithShellPathHydrationMock).toHaveBeenCalledWith({
      wslDistro: 'Ubuntu-24.04'
    })
    expect(refreshShellPathAndDetectAgentsMock).toHaveBeenCalledWith({ wslDefault: true })
    expect(detected).toMatchObject({ ok: true, result: ['claude'] })
  })

  it('rejects a malformed WSL target instead of probing with it', async () => {
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: PREFLIGHT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('preflight.detectAgents', { wslDistro: '' })
    )

    expect(response).toMatchObject({ ok: false })
    expect(detectInstalledAgentsWithShellPathHydrationMock).not.toHaveBeenCalled()
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
