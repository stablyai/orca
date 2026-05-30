import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspacePort, WorkspacePortScanResult } from '../../shared/workspace-ports'

const handlers = new Map<string, (_event: unknown, args: unknown) => Promise<unknown> | unknown>()
const { handleMock, scanWorkspacePortsMock, processKillMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  scanWorkspacePortsMock: vi.fn(),
  processKillMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  },
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('../ports/local-workspace-port-scanner', () => ({
  scanWorkspacePorts: scanWorkspacePortsMock
}))

import { registerWorkspacePortHandlers } from './workspace-ports'

const EMPTY_SCAN: WorkspacePortScanResult = {
  ports: [],
  platform: process.platform,
  scannedAt: 0
}

function makeStore() {
  return {
    getRepos: vi.fn(() => [
      {
        id: 'local-repo',
        path: '/workspace/repo',
        displayName: 'Local Repo',
        badgeColor: '#000',
        addedAt: 0
      },
      {
        id: 'remote-repo',
        path: '/remote/repo',
        displayName: 'Remote Repo',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: 'ssh-target'
      },
      {
        id: 'other-repo',
        path: '/workspace/other',
        displayName: 'Other Repo',
        badgeColor: '#000',
        addedAt: 0
      }
    ]),
    getAllWorktreeMeta: vi.fn(() => ({
      'local-repo::/workspace/repo': { displayName: 'Primary' },
      'remote-repo::/remote/repo': { displayName: 'Remote' },
      'other-repo::/workspace/other': { displayName: 'Other' },
      'malformed-worktree-id': { displayName: 'Malformed' }
    }))
  }
}

describe('registerWorkspacePortHandlers', () => {
  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    scanWorkspacePortsMock.mockReset()
    handleMock.mockImplementation((channel, handler) => {
      handlers.set(channel, handler)
    })
    scanWorkspacePortsMock.mockResolvedValue(EMPTY_SCAN)
    processKillMock.mockReset()
    vi.spyOn(process, 'kill').mockImplementation(processKillMock)
  })

  it('derives local worktree probes from the main store instead of renderer input', async () => {
    const store = makeStore()
    registerWorkspacePortHandlers(store as never)

    const handler = handlers.get('workspacePorts:scan')
    expect(handler).toBeDefined()

    await handler?.(null, {
      repoId: 'local-repo',
      worktrees: [{ id: 'attacker', path: '/tmp/not-authorized', repoId: 'local-repo' }]
    })

    expect(scanWorkspacePortsMock).toHaveBeenCalledWith([
      {
        id: 'local-repo::/workspace/repo',
        repoId: 'local-repo',
        displayName: 'Primary',
        path: '/workspace/repo'
      }
    ])
  })

  it('deduplicates concurrent scans for the same store-derived probe set', async () => {
    const store = makeStore()
    let resolveScan: (result: WorkspacePortScanResult) => void = () => {}
    scanWorkspacePortsMock.mockReturnValue(
      new Promise<WorkspacePortScanResult>((resolve) => {
        resolveScan = resolve
      })
    )
    registerWorkspacePortHandlers(store as never)

    const handler = handlers.get('workspacePorts:scan')
    expect(handler).toBeDefined()

    const first = handler?.(null, { repoId: 'local-repo' })
    const second = handler?.(null, { repoId: 'local-repo' })
    expect(scanWorkspacePortsMock).toHaveBeenCalledTimes(1)

    resolveScan(EMPTY_SCAN)
    await expect(Promise.all([first, second])).resolves.toEqual([EMPTY_SCAN, EMPTY_SCAN])
  })

  it('handles malformed renderer scan input as an unfiltered local scan', async () => {
    const store = makeStore()
    registerWorkspacePortHandlers(store as never)

    await handlers.get('workspacePorts:scan')?.(null, undefined)

    expect(scanWorkspacePortsMock).toHaveBeenCalledWith([
      {
        id: 'local-repo::/workspace/repo',
        repoId: 'local-repo',
        displayName: 'Primary',
        path: '/workspace/repo'
      },
      {
        id: 'other-repo::/workspace/other',
        repoId: 'other-repo',
        displayName: 'Other',
        path: '/workspace/other'
      }
    ])
  })

  it('stops a process only after the current scan proves the pid owns a workspace port', async () => {
    const store = makeStore()
    const port = workspacePort({ pid: 1234, port: 5173 })
    scanWorkspacePortsMock.mockResolvedValue({
      ...EMPTY_SCAN,
      ports: [port]
    })
    registerWorkspacePortHandlers(store as never)

    const result = await handlers.get('workspacePorts:kill')?.(null, {
      repoId: 'local-repo',
      pid: 1234,
      port: 5173
    })

    expect(result).toEqual({ ok: true })
    expect(processKillMock).toHaveBeenCalledWith(1234, 'SIGTERM')
  })

  it('refuses to stop external ports', async () => {
    const store = makeStore()
    scanWorkspacePortsMock.mockResolvedValue({
      ...EMPTY_SCAN,
      ports: [
        {
          id: '127.0.0.1:55182:2222',
          bindHost: '127.0.0.1',
          connectHost: '127.0.0.1',
          port: 55182,
          pid: 2222,
          processName: 'node',
          protocol: 'unknown',
          kind: 'external'
        }
      ]
    })
    registerWorkspacePortHandlers(store as never)

    const result = await handlers.get('workspacePorts:kill')?.(null, {
      repoId: 'local-repo',
      pid: 2222,
      port: 55182
    })

    expect(result).toEqual({
      ok: false,
      reason: 'Only workspace-owned local processes can be stopped here.'
    })
    expect(processKillMock).not.toHaveBeenCalled()
  })

  it('refuses stale or forged pid requests that do not match the current scan', async () => {
    const store = makeStore()
    scanWorkspacePortsMock.mockResolvedValue({
      ...EMPTY_SCAN,
      ports: [workspacePort({ pid: 1234, port: 5173 })]
    })
    registerWorkspacePortHandlers(store as never)

    const result = await handlers.get('workspacePorts:kill')?.(null, {
      repoId: 'local-repo',
      pid: 9999,
      port: 5173
    })

    expect(result).toEqual({ ok: false, reason: 'The port is no longer listening.' })
    expect(processKillMock).not.toHaveBeenCalled()
  })

  it('refuses malformed renderer kill input without throwing', async () => {
    const store = makeStore()
    registerWorkspacePortHandlers(store as never)

    const result = await handlers.get('workspacePorts:kill')?.(null, { pid: '1234', port: 5173 })

    expect(result).toEqual({ ok: false, reason: 'Invalid process or port.' })
    expect(scanWorkspacePortsMock).not.toHaveBeenCalled()
    expect(processKillMock).not.toHaveBeenCalled()
  })

  it('notifies renderers when a local worktree advertised URL changes', () => {
    const store = makeStore()
    type AdvertisedUrlListener = (event: { worktreeId: string; port: number }) => void
    let advertisedUrlListener: AdvertisedUrlListener | undefined
    const send = vi.fn()

    registerWorkspacePortHandlers(store as never, {
      advertisedUrlEvents: {
        onDidChange: (listener) => {
          advertisedUrlListener = listener
          return () => {}
        }
      },
      getWindows: () =>
        [
          {
            isDestroyed: () => false,
            webContents: {
              isDestroyed: () => false,
              send
            }
          }
        ] as never
    })

    expect(advertisedUrlListener).toBeTypeOf('function')
    const emitAdvertisedUrlChanged = advertisedUrlListener as AdvertisedUrlListener
    emitAdvertisedUrlChanged({ worktreeId: 'local-repo::/workspace/repo', port: 3002 })
    emitAdvertisedUrlChanged({ worktreeId: 'remote-repo::/remote/repo', port: 3003 })

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('workspacePorts:advertised-url-changed', {
      worktreeId: 'local-repo::/workspace/repo',
      port: 3002
    })
  })

  it('unsubscribes the previous advertised URL listener when handlers are registered again', () => {
    const store = makeStore()
    const firstUnsubscribe = vi.fn()
    const secondUnsubscribe = vi.fn()
    const onDidChange = vi
      .fn()
      .mockReturnValueOnce(firstUnsubscribe)
      .mockReturnValueOnce(secondUnsubscribe)

    registerWorkspacePortHandlers(store as never, {
      advertisedUrlEvents: { onDidChange }
    })
    registerWorkspacePortHandlers(store as never, {
      advertisedUrlEvents: { onDidChange }
    })

    expect(firstUnsubscribe).toHaveBeenCalledTimes(1)
    expect(secondUnsubscribe).not.toHaveBeenCalled()
  })
})

function workspacePort({ pid, port }: { pid: number; port: number }): WorkspacePort {
  return {
    id: `127.0.0.1:${port}:${pid}`,
    bindHost: '127.0.0.1',
    connectHost: '127.0.0.1',
    port,
    pid,
    processName: 'node',
    protocol: 'unknown',
    kind: 'workspace',
    owner: {
      worktreeId: 'local-repo::/workspace/repo',
      repoId: 'local-repo',
      displayName: 'Primary',
      path: '/workspace/repo',
      confidence: 'cwd'
    }
  }
}
