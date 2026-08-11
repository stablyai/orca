import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspacePortScanResult } from '../../shared/workspace-ports'
import { createPreviewRouteResolver } from './preview-route-resolver'
import type { PreviewWorktreeDescriptor } from './worktree-preview-routes'

const scanWorkspacePortProbesMock = vi.hoisted(() => vi.fn())

vi.mock('./workspace-port-ownership', () => ({
  scanWorkspacePortProbes: scanWorkspacePortProbesMock
}))

const descriptor: PreviewWorktreeDescriptor = {
  worktreeId: 'repo::/w/feat',
  repoId: 'repo',
  projectName: 'orca',
  worktreeName: 'feat',
  worktreePath: '/w/feat'
}

const owner = {
  worktreeId: descriptor.worktreeId,
  repoId: 'repo',
  displayName: 'feat',
  path: '/w/feat',
  confidence: 'cwd' as const
}

function scanWith(
  ports: { port: number; advertisedUrl?: string; protocol?: 'http' | 'https' | 'unknown' }[]
): WorkspacePortScanResult {
  return {
    platform: 'linux',
    scannedAt: 1,
    ports: ports.map(({ port, advertisedUrl, protocol = 'http' }) => ({
      id: `p${port}`,
      bindHost: '127.0.0.1',
      connectHost: 'localhost',
      port,
      protocol,
      kind: 'workspace' as const,
      owner,
      ...(advertisedUrl ? { advertisedUrl } : {})
    }))
  }
}

afterEach(() => {
  scanWorkspacePortProbesMock.mockReset()
})

describe('createPreviewRouteResolver', () => {
  it('marks the advertised port primary and excludes https listeners', async () => {
    scanWorkspacePortProbesMock.mockResolvedValue(
      scanWith([
        { port: 3000 },
        { port: 5173, advertisedUrl: 'http://localhost:5173' },
        { port: 8443, protocol: 'https' }
      ])
    )
    const resolve = createPreviewRouteResolver({ descriptors: async () => [descriptor] })

    const index = await resolve()
    const entry = index.get('feat')
    expect(entry?.primaryPort).toBe(5173)
    expect(entry?.ports.map((port) => port.port)).toEqual([3000, 5173])
  })

  it('makes a single detected port primary without an advertised URL', async () => {
    scanWorkspacePortProbesMock.mockResolvedValue(scanWith([{ port: 3000 }]))
    const resolve = createPreviewRouteResolver({ descriptors: async () => [descriptor] })

    expect((await resolve()).get('feat')?.primaryPort).toBe(3000)
  })

  it('serves cached routes inside the TTL and rescans when fresh is requested', async () => {
    scanWorkspacePortProbesMock.mockResolvedValue(scanWith([{ port: 3000 }]))
    let now = 0
    const resolve = createPreviewRouteResolver({
      descriptors: async () => [descriptor],
      ttlMs: 1_000,
      freshMinIntervalMs: 500,
      now: () => now
    })

    await resolve()
    await resolve()
    expect(scanWorkspacePortProbesMock).toHaveBeenCalledTimes(1)

    now = 600
    await resolve({ fresh: true })
    expect(scanWorkspacePortProbesMock).toHaveBeenCalledTimes(2)

    now = 2_000
    await resolve()
    expect(scanWorkspacePortProbesMock).toHaveBeenCalledTimes(3)
  })

  it('rate-limits fresh rescans right after a scan completed', async () => {
    scanWorkspacePortProbesMock.mockResolvedValue(scanWith([{ port: 3000 }]))
    let now = 0
    const resolve = createPreviewRouteResolver({
      descriptors: async () => [descriptor],
      ttlMs: 1_000,
      freshMinIntervalMs: 500,
      now: () => now
    })

    await resolve()
    // A miss-flood forcing fresh scans reuses the just-built index…
    now = 300
    await resolve({ fresh: true })
    expect(scanWorkspacePortProbesMock).toHaveBeenCalledTimes(1)

    // …but a fresh request past the interval still rescans inside the TTL.
    now = 600
    await resolve({ fresh: true })
    expect(scanWorkspacePortProbesMock).toHaveBeenCalledTimes(2)
  })

  it('lists a worktree with no listening ports so labels still resolve', async () => {
    scanWorkspacePortProbesMock.mockResolvedValue({ platform: 'linux', scannedAt: 1, ports: [] })
    const resolve = createPreviewRouteResolver({ descriptors: async () => [descriptor] })

    const entry = (await resolve()).get('feat')
    expect(entry).toMatchObject({ primaryPort: null, ports: [] })
  })
})
