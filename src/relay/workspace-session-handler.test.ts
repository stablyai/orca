import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import {
  MAX_PRESENCE_CLIENTS_PER_NAMESPACE,
  MAX_PRESENCE_NAMESPACES,
  MAX_WORKSPACE_SESSION_SNAPSHOT_BYTES,
  MAX_WORKSPACE_SESSION_SNAPSHOT_STRUCTURAL_TOKENS,
  WorkspaceSessionHandler
} from './workspace-session-handler'
import { encodeJsonRpcFrame, MessageType, type JsonRpcRequest } from './protocol'

function decodeJsonFrames(written: Buffer[]): unknown[] {
  return written
    .filter((buf) => buf[0] === MessageType.Regular)
    .map((buf) => {
      const len = buf.readUInt32BE(9)
      return JSON.parse(buf.subarray(13, 13 + len).toString('utf-8')) as unknown
    })
}

async function sendRequest(
  dispatcher: RelayDispatcher,
  method: string,
  params: Record<string, unknown>,
  id: number
): Promise<void> {
  const req: JsonRpcRequest = {
    jsonrpc: '2.0',
    id,
    method,
    params
  }
  dispatcher.feed(encodeJsonRpcFrame(req, id, 0))
  await Promise.resolve()
}

describe('WorkspaceSessionHandler', () => {
  let baseDir: string
  let dispatcher: RelayDispatcher
  let handler: WorkspaceSessionHandler
  let written: Buffer[]

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'orca-workspace-session-'))
    written = []
    dispatcher = new RelayDispatcher((data) => {
      written.push(Buffer.from(data))
    })
    handler = new WorkspaceSessionHandler(dispatcher, baseDir)
  })

  afterEach(() => {
    dispatcher.dispose()
    vi.useRealTimers()
    rmSync(baseDir, { recursive: true, force: true })
  })

  it('stores snapshots atomically and rejects stale revisions', async () => {
    const session = {
      activeWorktreePath: '/repo/worktree',
      activeTabId: 'tab-1',
      tabsByWorktreePath: {
        '/repo/worktree': [{ id: 'tab-1', title: 'Terminal', worktreePath: '/repo/worktree' }]
      },
      terminalLayoutsByTabId: {}
    }

    await sendRequest(
      dispatcher,
      'workspace.patch',
      {
        namespace: 'ssh target/path',
        baseRevision: 0,
        clientId: 'client-a',
        patch: { kind: 'replace-session', session }
      },
      1
    )

    const frames = decodeJsonFrames(written)
    const response = frames.find((frame) => (frame as { id?: number }).id === 1) as {
      result: { ok: boolean; snapshot: { revision: number; session: unknown } }
    }
    expect(response.result.ok).toBe(true)
    expect(response.result.snapshot.revision).toBe(1)
    expect(response.result.snapshot.session).toEqual(session)
    expect(
      frames.some((frame) => (frame as { method?: string }).method === 'workspace.changed')
    ).toBe(true)

    written = []
    await sendRequest(
      dispatcher,
      'workspace.patch',
      {
        namespace: 'ssh target/path',
        baseRevision: 0,
        clientId: 'client-b',
        patch: { kind: 'replace-session', session: { ...session, activeTabId: 'tab-2' } }
      },
      2
    )

    const staleResponse = decodeJsonFrames(written).find(
      (frame) => (frame as { id?: number }).id === 2
    ) as { result: { ok: boolean; reason: string; snapshot: { revision: number } } }
    expect(staleResponse.result.ok).toBe(false)
    expect(staleResponse.result.reason).toBe('stale-revision')
    expect(staleResponse.result.snapshot.revision).toBe(1)
  })

  it('starts fresh when a persisted snapshot exceeds the file cap', async () => {
    const snapshotPath = join(baseDir, 'oversized.json')
    const file = openSync(snapshotPath, 'w')
    ftruncateSync(file, MAX_WORKSPACE_SESSION_SNAPSHOT_BYTES + 1)
    closeSync(file)

    await sendRequest(dispatcher, 'workspace.get', { namespace: 'oversized' }, 1)

    const response = decodeJsonFrames(written).find(
      (frame) => (frame as { id?: number }).id === 1
    ) as { result: { revision: number; session: { activeRepoId: unknown } } }
    expect(response.result.revision).toBe(0)
    expect(response.result.session.activeRepoId).toBeNull()
  })

  it('starts fresh when a bounded snapshot amplifies structure before parsing', () => {
    writeFileSync(
      join(baseDir, 'amplified.json'),
      `[${'0,'.repeat(MAX_WORKSPACE_SESSION_SNAPSHOT_STRUCTURAL_TOKENS)}0]`
    )
    const parseSpy = vi.spyOn(JSON, 'parse')

    const snapshot = (
      handler as unknown as {
        read(namespace: string): { revision: number; session: { activeRepoId: unknown } }
      }
    ).read('amplified')

    expect(snapshot.revision).toBe(0)
    expect(snapshot.session.activeRepoId).toBeNull()
    expect(parseSpy).not.toHaveBeenCalled()
    parseSpy.mockRestore()
  })

  it('tracks presence per namespace', async () => {
    await sendRequest(
      dispatcher,
      'workspace.presence',
      {
        namespace: 'team',
        clientId: 'client-a',
        clientName: ' Laptop   A '
      },
      1
    )
    await sendRequest(
      dispatcher,
      'workspace.presence',
      {
        namespace: 'team',
        clientId: 'client-b',
        clientName: 'Laptop B'
      },
      2
    )

    const response = decodeJsonFrames(written).find(
      (frame) => (frame as { id?: number }).id === 2
    ) as {
      result: { clients: { clientId: string; name: string }[] }
    }
    expect(response.result.clients.map((client) => client.clientId).sort()).toEqual([
      'client-a',
      'client-b'
    ])
    expect(response.result.clients.find((client) => client.clientId === 'client-a')?.name).toBe(
      'Laptop A'
    )
  })

  it('does not retain namespaces for presence queries without a client id', async () => {
    for (let index = 0; index < MAX_PRESENCE_NAMESPACES + 10; index += 1) {
      await sendRequest(
        dispatcher,
        'workspace.presence',
        { namespace: `query-${index}` },
        index + 1
      )
    }

    const namespaces = (handler as unknown as { clientsByNamespace: Map<string, unknown> })
      .clientsByNamespace
    expect(namespaces.size).toBe(0)
  })

  it('sweeps expired clients from every namespace on any heartbeat', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    await sendRequest(dispatcher, 'workspace.presence', { namespace: 'a', clientId: 'a' }, 1)
    await sendRequest(dispatcher, 'workspace.presence', { namespace: 'b', clientId: 'b' }, 2)

    vi.setSystemTime(new Date('2026-01-01T00:01:00Z'))
    await sendRequest(dispatcher, 'workspace.presence', { namespace: 'c', clientId: 'c' }, 3)

    const namespaces = (handler as unknown as { clientsByNamespace: Map<string, unknown> })
      .clientsByNamespace
    expect(Array.from(namespaces.keys())).toEqual(['c'])
  })

  it('bounds clients per namespace by evicting the oldest heartbeat', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    for (let index = 0; index <= MAX_PRESENCE_CLIENTS_PER_NAMESPACE; index += 1) {
      vi.setSystemTime(Date.now() + 1)
      await sendRequest(
        dispatcher,
        'workspace.presence',
        { namespace: 'team', clientId: `client-${String(index).padStart(3, '0')}` },
        index + 1
      )
    }

    const clients = (
      handler as unknown as {
        clientsByNamespace: Map<string, Map<string, ConnectedClientForTest>>
      }
    ).clientsByNamespace.get('team')
    expect(clients?.size).toBe(MAX_PRESENCE_CLIENTS_PER_NAMESPACE)
    expect(clients?.has('client-000')).toBe(false)
    expect(
      clients?.has(`client-${String(MAX_PRESENCE_CLIENTS_PER_NAMESPACE).padStart(3, '0')}`)
    ).toBe(true)
  })

  it('bounds namespaces by evicting the least recently active one', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    for (let index = 0; index <= MAX_PRESENCE_NAMESPACES; index += 1) {
      vi.setSystemTime(Date.now() + 1)
      await sendRequest(
        dispatcher,
        'workspace.presence',
        {
          namespace: `space-${String(index).padStart(3, '0')}`,
          clientId: `client-${index}`
        },
        index + 1
      )
    }

    const namespaces = (handler as unknown as { clientsByNamespace: Map<string, unknown> })
      .clientsByNamespace
    expect(namespaces.size).toBe(MAX_PRESENCE_NAMESPACES)
    expect(namespaces.has('space-000')).toBe(false)
    expect(namespaces.has(`space-${MAX_PRESENCE_NAMESPACES}`)).toBe(true)
  })
})

type ConnectedClientForTest = { clientId: string; name: string; lastSeenAt: number }
