import { afterEach, describe, expect, it, vi } from 'vitest'
import { killWorkspacePort } from './workspace-port-ownership'

const scanWorkspacePortsMock = vi.hoisted(() => vi.fn())

vi.mock('./local-workspace-port-scanner', () => ({
  scanWorkspacePorts: scanWorkspacePortsMock
}))

function workspacePortScan(pid: number, port: number) {
  return {
    platform: 'win32' as const,
    scannedAt: 0,
    ports: [
      {
        id: `127.0.0.1:${port}:${pid}`,
        bindHost: '127.0.0.1',
        connectHost: '127.0.0.1',
        port,
        pid,
        protocol: 'http' as const,
        kind: 'workspace' as const,
        worktreeId: worktrees[0]!.id
      }
    ]
  }
}

const worktrees = [{ id: 'repo::/repo', repoId: 'repo', displayName: 'main', path: '/repo' }]

describe('killWorkspacePort', () => {
  afterEach(() => {
    scanWorkspacePortsMock.mockReset()
    vi.restoreAllMocks()
  })

  it('reports success when the listener exited before the signal landed', async () => {
    // Why: the re-scan authorizes the pid, then the dev server exits on its own
    // before `kill` runs. The port is free -- which is what Stop asked for --
    // but the raw ESRCH surfaced as "Stop failed" on a port that was gone.
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    })
    scanWorkspacePortsMock.mockResolvedValue(workspacePortScan(123, 5173))

    expect(await killWorkspacePort(worktrees, { pid: 123, port: 5173 })).toEqual({ ok: true })
  })

  it('still reports a real failure to stop', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    })
    scanWorkspacePortsMock.mockResolvedValue(workspacePortScan(123, 5173))

    expect(await killWorkspacePort(worktrees, { pid: 123, port: 5173 })).toEqual({
      ok: false,
      reason: 'kill EPERM'
    })
  })

  it('signals the pid the socket scan named, which is the listener itself', async () => {
    // Why pinned: netstat -ano / lsof report the process that owns the socket,
    // not a supervising wrapper, so escalating this to a tree kill would reach
    // descendants nobody asked to stop without freeing anything extra.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    scanWorkspacePortsMock.mockResolvedValue(workspacePortScan(123, 5173))

    expect(await killWorkspacePort(worktrees, { pid: 123, port: 5173 })).toEqual({ ok: true })
    expect(killSpy).toHaveBeenCalledExactlyOnceWith(123, 'SIGTERM')
  })

  // Regression for #11161 review: on an EDR-hooked host the background poller
  // alternates the metadata skip, so an unscoped skip would fail Stop with
  // "Only workspace-owned local processes can be stopped here" every other try.
  it('requires owner metadata from the authorizing re-scan', async () => {
    scanWorkspacePortsMock.mockResolvedValue({ platform: 'darwin', scannedAt: 0, ports: [] })

    await killWorkspacePort(worktrees, { pid: 123, port: 5173 })

    expect(scanWorkspacePortsMock).toHaveBeenCalledWith(worktrees, undefined, {
      requireMetadata: true
    })
  })

  it('refuses a pid the re-scan does not attribute to a workspace', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    scanWorkspacePortsMock.mockResolvedValue({
      platform: 'darwin',
      scannedAt: 0,
      ports: [
        {
          id: '127.0.0.1:5173:123',
          bindHost: '127.0.0.1',
          connectHost: '127.0.0.1',
          port: 5173,
          pid: 123,
          protocol: 'http',
          kind: 'external'
        }
      ]
    })

    const result = await killWorkspacePort(worktrees, { pid: 123, port: 5173 })

    expect(result).toEqual({
      ok: false,
      reason: 'Only workspace-owned local processes can be stopped here.'
    })
    expect(killSpy).not.toHaveBeenCalled()
  })
})
