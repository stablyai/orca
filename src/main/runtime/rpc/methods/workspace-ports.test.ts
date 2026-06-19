import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKSPACE_PORT_METHODS } from './workspace-ports'
import type { WorkspacePortScanResult } from '../../../../shared/workspace-ports'

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
})
