import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  killWorkspacePortOnExecutionHost,
  scanWorkspacePortsOnExecutionHost,
  type WorkspacePortExecutionHostDeps
} from './workspace-port-execution-host'
import type { WorkspacePortScanResult } from '../../shared/workspace-ports'

const scanWorkspacePortsMock = vi.hoisted(() => vi.fn())

vi.mock('./local-workspace-port-scanner', () => ({
  scanWorkspacePorts: scanWorkspacePortsMock
}))

const LOCAL_PROBE = { id: 'repo::/srv/app', repoId: 'repo', displayName: 'app', path: '/srv/app' }

// Same pid and port on this host and on the SSH host: only the host binding tells them apart.
const PID = 4242
const PORT = 3020

function localWorkspaceScan(): WorkspacePortScanResult {
  return {
    platform: 'linux',
    scannedAt: 1,
    ports: [
      {
        id: `0.0.0.0:${PORT}:${PID}`,
        kind: 'workspace',
        bindHost: '0.0.0.0',
        connectHost: 'localhost',
        port: PORT,
        pid: PID,
        protocol: 'http',
        owner: {
          worktreeId: LOCAL_PROBE.id,
          repoId: LOCAL_PROBE.repoId,
          displayName: LOCAL_PROBE.displayName,
          path: LOCAL_PROBE.path,
          confidence: 'cwd'
        }
      }
    ]
  }
}

function deps(
  request?: (method: string) => Promise<unknown>,
  connected = true
): WorkspacePortExecutionHostDeps & { request: ReturnType<typeof vi.fn> } {
  const requestMock = vi.fn(request ?? (async () => ({ ports: [], platform: 'linux' })))
  return {
    request: requestMock,
    getLocalProbes: async () => [LOCAL_PROBE],
    getSshMultiplexer: (targetId) =>
      connected && targetId === 'box' ? { request: requestMock } : undefined
  }
}

describe('scanWorkspacePortsOnExecutionHost', () => {
  afterEach(() => {
    scanWorkspacePortsMock.mockReset()
    vi.restoreAllMocks()
  })

  it('scans this host for a local workspace and names the host', async () => {
    scanWorkspacePortsMock.mockResolvedValue(localWorkspaceScan())
    const d = deps()

    const result = await scanWorkspacePortsOnExecutionHost('local', d)

    expect(scanWorkspacePortsMock).toHaveBeenCalledWith([LOCAL_PROBE], undefined, undefined)
    expect(d.request).not.toHaveBeenCalled()
    expect(result).toMatchObject({ executionHostId: 'local', platform: 'linux' })
    expect(result.ports).toHaveLength(1)
  })

  it("scans the workspace's SSH host through its relay, never this host", async () => {
    const d = deps(async () => ({
      platform: 'linux',
      ports: [{ port: PORT, host: '0.0.0.0', pid: PID, processName: 'node' }]
    }))

    const result = await scanWorkspacePortsOnExecutionHost('ssh:box', d)

    expect(scanWorkspacePortsMock).not.toHaveBeenCalled()
    expect(d.request).toHaveBeenCalledWith('ports.detect', undefined, expect.any(Object))
    expect(result).toMatchObject({
      executionHostId: 'ssh:box',
      platform: 'linux',
      ports: [
        {
          kind: 'external',
          bindHost: '0.0.0.0',
          connectHost: 'localhost',
          port: PORT,
          pid: PID,
          processName: 'node'
        }
      ]
    })
    expect(result.unavailableReason).toBeUndefined()
  })

  it('reports a disconnected SSH host as unavailable, not as an empty host', async () => {
    const result = await scanWorkspacePortsOnExecutionHost('ssh:box', deps(undefined, false))

    expect(result).toMatchObject({ executionHostId: 'ssh:box', ports: [] })
    expect(result.unavailableReason).toMatch(/not connected/)
  })

  it('reports a failed or unsupported relay scan as unavailable', async () => {
    const failed = await scanWorkspacePortsOnExecutionHost(
      'ssh:box',
      deps(async () => {
        throw new Error('Request "ports.detect" timed out after 10000ms')
      })
    )
    const unsupported = await scanWorkspacePortsOnExecutionHost(
      'ssh:box',
      deps(async () => ({ ports: [], platform: 'darwin' }))
    )
    const malformed = await scanWorkspacePortsOnExecutionHost(
      'ssh:box',
      deps(async () => ({ ports: [{ port: 'x' }], platform: 'linux' }))
    )

    expect(failed.unavailableReason).toMatch(/timed out/)
    expect(unsupported.unavailableReason).toMatch(/not supported/)
    expect(malformed.unavailableReason).toMatch(/invalid/)
  })

  it('refuses a workspace hosted by another server instead of scanning here', async () => {
    const d = deps()
    const result = await scanWorkspacePortsOnExecutionHost('runtime:env-2', d)

    expect(scanWorkspacePortsMock).not.toHaveBeenCalled()
    expect(d.request).not.toHaveBeenCalled()
    expect(result.unavailableReason).toBeTruthy()
  })
})

describe('killWorkspacePortOnExecutionHost', () => {
  afterEach(() => {
    scanWorkspacePortsMock.mockReset()
    vi.restoreAllMocks()
  })

  it('stops a workspace-owned listener on this host after re-proving ownership', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    scanWorkspacePortsMock.mockResolvedValue(localWorkspaceScan())

    const result = await killWorkspacePortOnExecutionHost(
      'local',
      { executionHostId: 'local', pid: PID, port: PORT },
      deps()
    )

    expect(result).toEqual({ ok: true })
    expect(scanWorkspacePortsMock).toHaveBeenCalledWith([LOCAL_PROBE], undefined, {
      requireMetadata: true
    })
    expect(kill).toHaveBeenCalledWith(PID, 'SIGTERM')
  })

  it("never signals this host's same pid for a row scanned on the SSH host", async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    scanWorkspacePortsMock.mockResolvedValue(localWorkspaceScan())

    const result = await killWorkspacePortOnExecutionHost(
      'local',
      { executionHostId: 'ssh:box', pid: PID, port: PORT },
      deps()
    )

    expect(result).toMatchObject({ ok: false })
    expect(kill).not.toHaveBeenCalled()
    expect(scanWorkspacePortsMock).not.toHaveBeenCalled()
  })

  it('refuses to stop on an SSH host, where ownership cannot be proven', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const d = deps()

    const result = await killWorkspacePortOnExecutionHost(
      'ssh:box',
      { executionHostId: 'ssh:box', pid: PID, port: PORT },
      d
    )

    expect(result).toEqual({
      ok: false,
      reason: 'Stopping processes on an SSH host is not supported yet.'
    })
    expect(kill).not.toHaveBeenCalled()
    expect(d.request).not.toHaveBeenCalled()
  })
})
