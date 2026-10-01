import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { PreflightRuntimeContext } from '../../../ipc/preflight-runtime-target'
import { resolveProjectExecutionRuntime } from '../../../../shared/project-execution-runtime'
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

const NAMED_WSL_CONTEXT: PreflightRuntimeContext = {
  projectRuntime: resolveProjectExecutionRuntime({
    appPlatform: 'win32',
    projectId: 'local-project',
    globalWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
  })
}

const NULL_DISTRO_REPAIR_CONTEXT: PreflightRuntimeContext = {
  projectRuntime: resolveProjectExecutionRuntime({
    appPlatform: 'win32',
    projectId: 'local-project',
    globalWindowsRuntimeDefault: { kind: 'wsl', distro: null }
  })
}

function makeRuntime(hostAgentContext?: PreflightRuntimeContext): OrcaRuntimeService {
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    getHostAgentPreflightContext: () => hostAgentContext
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: preflight handlers only read these two runtime methods.
  return runtime as unknown as OrcaRuntimeService
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
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(), methods: PREFLIGHT_METHODS })

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
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(), methods: PREFLIGHT_METHODS })

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

  it.each<[string, PreflightRuntimeContext]>([
    ['detects agents in the named WSL distro of the host default', NAMED_WSL_CONTEXT],
    ['forwards the null-distro repair context to agent detection', NULL_DISTRO_REPAIR_CONTEXT]
  ])('%s for paired clients', async (_title, hostAgentContext) => {
    detectInstalledAgentsWithShellPathHydrationMock.mockResolvedValueOnce(['claude'])
    refreshShellPathAndDetectAgentsMock.mockResolvedValueOnce({ agents: ['claude'] })
    const dispatcher = new RpcDispatcher({
      runtime: makeRuntime(hostAgentContext),
      methods: PREFLIGHT_METHODS
    })

    await dispatcher.dispatch(makeRequest('preflight.detectAgents'))
    await dispatcher.dispatch(makeRequest('preflight.refreshAgents'))

    expect(detectInstalledAgentsWithShellPathHydrationMock).toHaveBeenCalledWith(hostAgentContext)
    expect(refreshShellPathAndDetectAgentsMock).toHaveBeenCalledWith(hostAgentContext)
  })

  it('returns the repair error to the paired client when detection refuses it', async () => {
    detectInstalledAgentsWithShellPathHydrationMock.mockRejectedValueOnce(
      new Error('Project runtime requires repair before preflight: wsl-distro-required')
    )
    const dispatcher = new RpcDispatcher({
      runtime: makeRuntime(NULL_DISTRO_REPAIR_CONTEXT),
      methods: PREFLIGHT_METHODS
    })

    const response = await dispatcher.dispatch(makeRequest('preflight.detectAgents'))

    expect(detectInstalledAgentsWithShellPathHydrationMock).toHaveBeenCalledWith(
      NULL_DISTRO_REPAIR_CONTEXT
    )
    expect(response).toMatchObject({ ok: false })
    expect(JSON.stringify(response)).toContain('wsl-distro-required')
  })

  it('detects agents on remote SSH connections through runtime RPC', async () => {
    detectRemoteAgentsMock.mockResolvedValueOnce(['claude'])
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(), methods: PREFLIGHT_METHODS })

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
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(), methods: PREFLIGHT_METHODS })

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
