import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKSPACE_PORT_METHODS } from './workspace-ports'
import type { WorkspacePortScanResult } from '../../../../shared/workspace-ports'

function hostScopedRuntime(
  methods: Partial<Pick<OrcaRuntimeService, 'scanWorkspacePortsOnHost' | 'killWorkspacePortOnHost'>>
): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch reaches only the runtime id and the one host-scoped method each test stubs.
  return { getRuntimeId: () => 'test-runtime', ...methods } as unknown as OrcaRuntimeService
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('workspace port RPC methods', () => {
  it('scans workspace ports on the runtime host', async () => {
    const scan: WorkspacePortScanResult = {
      platform: process.platform,
      scannedAt: 123,
      ports: []
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      scanWorkspacePorts: vi.fn().mockResolvedValue(scan)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKSPACE_PORT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('workspacePorts.scan', { repoId: 'repo-1' })
    )

    expect(runtime.scanWorkspacePorts).toHaveBeenCalledWith('repo-1')
    expect(response).toMatchObject({ ok: true, result: scan })
  })

  it('kills a workspace-owned port on the runtime host', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      killWorkspacePort: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKSPACE_PORT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('workspacePorts.kill', {
        repoId: 'repo-1',
        pid: 1234,
        port: 5173
      })
    )

    expect(runtime.killWorkspacePort).toHaveBeenCalledWith({
      repoId: 'repo-1',
      pid: 1234,
      port: 5173
    })
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })

  it('scans the host a workspace resolves to and returns that host with the rows', async () => {
    const scan = {
      executionHostId: 'ssh:box',
      platform: 'linux',
      scannedAt: 1,
      ports: []
    }
    const runtime = hostScopedRuntime({
      scanWorkspacePortsOnHost: vi.fn().mockResolvedValue(scan)
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKSPACE_PORT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('workspacePorts.scanHost', { worktree: 'id:repo-1::/srv/app' })
    )

    expect(runtime.scanWorkspacePortsOnHost).toHaveBeenCalledWith('id:repo-1::/srv/app')
    expect(response).toMatchObject({ ok: true, result: scan })
  })

  it('binds a host-scoped Stop to the workspace and the host its row was scanned on', async () => {
    const runtime = hostScopedRuntime({
      killWorkspacePortOnHost: vi.fn().mockResolvedValue({ ok: true })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKSPACE_PORT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('workspacePorts.killHost', {
        worktree: 'id:repo-1::/srv/app',
        executionHostId: 'local',
        pid: 1234,
        port: 5173
      })
    )

    expect(runtime.killWorkspacePortOnHost).toHaveBeenCalledWith({
      worktree: 'id:repo-1::/srv/app',
      executionHostId: 'local',
      pid: 1234,
      port: 5173
    })
    expect(response).toMatchObject({ ok: true, result: { ok: true } })
  })

  it('refuses a host-scoped Stop that names no host', async () => {
    const runtime = hostScopedRuntime({ killWorkspacePortOnHost: vi.fn() })
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKSPACE_PORT_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('workspacePorts.killHost', { worktree: 'id:w', pid: 1, port: 2 })
    )

    expect(response).toMatchObject({ ok: false })
    expect(runtime.killWorkspacePortOnHost).not.toHaveBeenCalled()
  })
})
