import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { PREFLIGHT_METHODS } from './preflight'
import { SSH_HOST_NOT_SERVED_MESSAGE } from '../../../providers/ssh-host-not-served-error'

const {
  detectInstalledAgentsWithShellPathHydrationMock,
  detectRemoteWindowsTerminalCapabilitiesMock,
  refreshShellPathAndDetectAgentsMock,
  runPreflightCheckMock,
  assertWslDistroRunningForExecMock
} = vi.hoisted(() => ({
  assertWslDistroRunningForExecMock: vi.fn(async (_distro?: string | null) => {}),
  detectInstalledAgentsWithShellPathHydrationMock: vi.fn(),
  detectRemoteWindowsTerminalCapabilitiesMock: vi.fn(),
  refreshShellPathAndDetectAgentsMock: vi.fn(),
  runPreflightCheckMock: vi.fn()
}))

vi.mock('../../../preflight/agent-detection', () => ({
  detectInstalledAgentsWithShellPathHydration: detectInstalledAgentsWithShellPathHydrationMock,
  detectRemoteWindowsTerminalCapabilities: detectRemoteWindowsTerminalCapabilitiesMock,
  refreshShellPathAndDetectAgents: refreshShellPathAndDetectAgentsMock,
  runPreflightCheck: runPreflightCheckMock
}))

// The running gate is real on Windows CI; each case states whether the distro runs.
vi.mock('../../../wsl/wsl-background-exec-gate', () => ({
  assertWslDistroRunningForExec: assertWslDistroRunningForExecMock
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
    const resolveAgentDetectionHost = vi.fn(() => ({ kind: 'local' }) as const)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these methods read only resolveAgentDetectionHost and getRuntimeId from the runtime.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveAgentDetectionHost
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: PREFLIGHT_METHODS })

    const detected = await dispatcher.dispatch(makeRequest('preflight.detectAgents'))
    const refreshed = await dispatcher.dispatch(makeRequest('preflight.refreshAgents', null))

    // An older client sends no workspace and keeps the host-default probe.
    expect(resolveAgentDetectionHost).toHaveBeenNthCalledWith(1, undefined, undefined)
    expect(resolveAgentDetectionHost).toHaveBeenNthCalledWith(2, undefined, undefined)
    expect(detectInstalledAgentsWithShellPathHydrationMock).toHaveBeenCalledWith(
      undefined,
      undefined
    )
    expect(refreshShellPathAndDetectAgentsMock).toHaveBeenCalledWith(undefined)
    expect(detected).toMatchObject({ ok: true, result: ['codex'] })
    expect(refreshed).toMatchObject({
      ok: true,
      result: { agents: ['codex', 'claude'], shellHydrationOk: true }
    })
  })

  it('probes the runtime the host resolves for the requested workspace (#19885)', async () => {
    const projectRuntime = {
      status: 'resolved',
      runtime: {
        kind: 'wsl',
        hostPlatform: 'wsl',
        projectId: 'p1',
        distro: 'Ubuntu',
        reason: 'project-override',
        cacheKey: 'p1:wsl:Ubuntu'
      }
    } as const
    detectInstalledAgentsWithShellPathHydrationMock.mockClear()
    detectInstalledAgentsWithShellPathHydrationMock.mockResolvedValueOnce(['codex'])
    const resolveAgentDetectionHost = vi.fn((worktreeId?: string) =>
      worktreeId === 'repo-ssh::/srv/w'
        ? ({ kind: 'ssh', connectionId: 'ssh-1' } as const)
        : ({ kind: 'local', context: { projectRuntime } } as const)
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these methods read only resolveAgentDetectionHost and getRuntimeId from the runtime.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveAgentDetectionHost
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: PREFLIGHT_METHODS })

    const wsl = await dispatcher.dispatch(
      makeRequest('preflight.detectAgents', { worktreeId: 'repo-1::\\\\wsl.localhost\\Ubuntu\\w' })
    )
    const ssh = await dispatcher.dispatch(
      makeRequest('preflight.detectAgents', { worktreeId: 'repo-ssh::/srv/w' })
    )

    expect(detectInstalledAgentsWithShellPathHydrationMock).toHaveBeenCalledWith(
      { projectRuntime },
      undefined
    )
    expect(wsl).toMatchObject({ ok: true, result: ['codex'] })
    expect(detectInstalledAgentsWithShellPathHydrationMock).toHaveBeenCalledTimes(1)
    expect(ssh).toMatchObject({ ok: false, error: { message: SSH_HOST_NOT_SERVED_MESSAGE } })
  })

  it("refuses a paired client's detection in a stopped WSL distro without probing it (E9)", async () => {
    const projectRuntime = {
      status: 'resolved',
      runtime: {
        kind: 'wsl',
        hostPlatform: 'wsl',
        projectId: 'p1',
        distro: 'Ubuntu',
        reason: 'project-override',
        cacheKey: 'p1:wsl:Ubuntu'
      }
    } as const
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    assertWslDistroRunningForExecMock.mockRejectedValueOnce(
      new Error("WSL distro 'Ubuntu' is not running.")
    )
    detectInstalledAgentsWithShellPathHydrationMock.mockClear()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these methods read only resolveAgentDetectionHost and getRuntimeId from the runtime.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveAgentDetectionHost: () => ({ kind: 'local', context: { projectRuntime } }) as const
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: PREFLIGHT_METHODS })
    try {
      const response = await dispatcher.dispatch(
        makeRequest('preflight.detectAgents', {
          worktreeId: 'repo-1::\\\\wsl.localhost\\Ubuntu\\w'
        })
      )
      expect(response).toMatchObject({ ok: false })
      expect(assertWslDistroRunningForExecMock).toHaveBeenLastCalledWith('Ubuntu')
      expect(detectInstalledAgentsWithShellPathHydrationMock).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('forwards a repo target before workspace creation and rejects malformed ids', async () => {
    detectInstalledAgentsWithShellPathHydrationMock.mockResolvedValueOnce(['codex'])
    const resolveAgentDetectionHost = vi.fn(() => ({ kind: 'local' }) as const)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only these two runtime members.
    const runtime = {
      getRuntimeId: () => 'runtime',
      resolveAgentDetectionHost
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: PREFLIGHT_METHODS })
    const response = await dispatcher.dispatch(
      makeRequest('preflight.detectAgents', {
        repoId: 'r1',
        path: '/client-controlled',
        wslDistro: 'client-controlled',
        executionHostId: 'local'
      })
    )
    expect(resolveAgentDetectionHost).toHaveBeenCalledWith(undefined, 'r1')
    expect(response).toMatchObject({ ok: true, result: ['codex'] })
    resolveAgentDetectionHost.mockClear()
    for (const repoId of ['', null, 1, { path: '/client-controlled' }]) {
      const malformed = await dispatcher.dispatch(makeRequest('preflight.detectAgents', { repoId }))
      expect(malformed).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    }
    expect(resolveAgentDetectionHost).not.toHaveBeenCalled()
  })

  it('routes a project through its launch context and rejects mixed selectors before detection', async () => {
    const context = { agents: ['codex'], workspaceKind: 'git', executionContext: { kind: 'host' } }
    const detectProjectLaunchContext = vi.fn().mockResolvedValue(context)
    const resolveAgentDetectionHost = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only these runtime members.
    const runtime = {
      getRuntimeId: () => 'runtime',
      detectProjectLaunchContext,
      resolveAgentDetectionHost
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: PREFLIGHT_METHODS })
    const project = { repo: 'r1' }
    const response = await dispatcher.dispatch(makeRequest('preflight.detectAgents', { project }))
    expect(response).toMatchObject({ ok: true, result: context })
    expect(detectProjectLaunchContext).toHaveBeenCalledExactlyOnceWith('r1')
    detectProjectLaunchContext.mockClear()
    for (const selector of [{ repoId: 'r1' }, { worktreeId: 'r1::/work' }]) {
      const mixed = await dispatcher.dispatch(
        makeRequest('preflight.detectAgents', { project, ...selector })
      )
      expect(mixed).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    }
    expect(detectProjectLaunchContext).not.toHaveBeenCalled()
    expect(resolveAgentDetectionHost).not.toHaveBeenCalled()
  })

  it.each(['preflight.detectAgents', 'preflight.refreshAgents'])(
    '%s never probes locally after repository ownership refuses',
    async (method) => {
      detectInstalledAgentsWithShellPathHydrationMock.mockClear()
      refreshShellPathAndDetectAgentsMock.mockClear()
      const resolveAgentDetectionHost = vi
        .fn()
        .mockRejectedValue(new Error('workspace_on_other_runtime'))
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only these runtime members.
      const runtime = {
        getRuntimeId: () => 'runtime',
        resolveAgentDetectionHost
      } as unknown as OrcaRuntimeService
      const dispatcher = new RpcDispatcher({ runtime, methods: PREFLIGHT_METHODS })
      const response = await dispatcher.dispatch(makeRequest(method, { repoId: 'foreign-repo' }))
      expect(resolveAgentDetectionHost).toHaveBeenCalledWith(undefined, 'foreign-repo')
      expect(response).toMatchObject({
        ok: false,
        error: { message: 'workspace_on_other_runtime' }
      })
      expect(detectInstalledAgentsWithShellPathHydrationMock).not.toHaveBeenCalled()
      expect(refreshShellPathAndDetectAgentsMock).not.toHaveBeenCalled()
    }
  )

  it('refuses agent detection on an SSH target this host does not serve', async () => {
    detectInstalledAgentsWithShellPathHydrationMock.mockClear()
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: PREFLIGHT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('preflight.detectRemoteAgents', { connectionId: 'ssh-1' })
    )

    expect(response).toMatchObject({ ok: false, error: { message: SSH_HOST_NOT_SERVED_MESSAGE } })
    expect(detectInstalledAgentsWithShellPathHydrationMock).not.toHaveBeenCalled()
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
