import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import { DISPATCHER_CONTROL_QUEUE_MAX_FRAMES } from './dispatcher-writer-admission'
import { WorkspaceSessionHandler } from './workspace-session-handler'
import { encodeJsonRpcFrame, MessageType, type JsonRpcRequest } from './protocol'

const NODE_21_HIGH_WATER_MARK = 16 * 1024

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
  let written: Buffer[]

  function installDispatcher(
    write: ConstructorParameters<typeof RelayDispatcher>[0] = (data) => {
      written.push(Buffer.from(data))
    },
    sinkOptions?: ConstructorParameters<typeof RelayDispatcher>[1]
  ): void {
    dispatcher?.dispose()
    written = []
    dispatcher = new RelayDispatcher(write, sinkOptions)
    new WorkspaceSessionHandler(dispatcher, baseDir)
  }

  async function patchSession(
    session: Record<string, unknown>,
    id = 1,
    baseRevision = 0
  ): Promise<void> {
    await sendRequest(
      dispatcher,
      'workspace.patch',
      {
        namespace: 'ssh target/path',
        baseRevision,
        clientId: 'client-a',
        patch: { kind: 'replace-session', session }
      },
      id
    )
  }

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'orca-workspace-session-'))
    installDispatcher()
  })

  afterEach(() => {
    dispatcher.dispose()
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
    expect(
      frames.some((frame) => (frame as { method?: string }).method === 'workspace.refreshRequired')
    ).toBe(false)

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

  it('falls back to a refresh notification when the snapshot exceeds producer capacity', async () => {
    installDispatcher(
      (data) => {
        written.push(Buffer.from(data))
      },
      {
        writableLength: () => 0,
        writableHighWaterMark: () => NODE_21_HIGH_WATER_MARK
      }
    )
    const session = {
      activeWorktreePath: '/repo/worktree',
      activeTabId: 'tab-1',
      tabsByWorktreePath: {
        '/repo/worktree': [{ id: 'tab-1', title: 'x'.repeat(20_000) }]
      },
      terminalLayoutsByTabId: {}
    }

    await patchSession(session)

    const frames = decodeJsonFrames(written) as {
      id?: number
      method?: string
      params?: Record<string, unknown>
      result?: { ok?: boolean; snapshot?: { revision?: number } }
    }[]
    expect(frames.some((frame) => frame.method === 'workspace.changed')).toBe(false)
    expect(frames.find((frame) => frame.method === 'workspace.refreshRequired')?.params).toEqual({
      namespace: 'ssh_target_path',
      revision: 1,
      sourceClientId: 'client-a'
    })
    expect(frames.find((frame) => frame.id === 1)?.result).toMatchObject({
      ok: true,
      snapshot: { revision: 1 }
    })

    await sendRequest(dispatcher, 'workspace.get', { namespace: 'ssh target/path' }, 2)
    expect(
      (decodeJsonFrames(written) as { id?: number; result?: { revision?: number } }[]).find(
        (frame) => frame.id === 2
      )?.result?.revision
    ).toBe(1)
  })

  it('uses the control fallback when the producer queue is full', async () => {
    const secondaryWritten: Buffer[] = []
    const drainListeners = new Set<() => void>()
    let blocked = true
    const secondaryId = dispatcher.attachClient(
      (data) => {
        secondaryWritten.push(Buffer.from(data))
        return !blocked
      },
      {
        writableLength: () => 0,
        writableHighWaterMark: () => 4 * 1024 * 1024,
        waitWriteDrain: (callback) => {
          drainListeners.add(callback)
          return () => drainListeners.delete(callback)
        }
      }
    )
    for (const size of [40_000, 1_000, 1]) {
      while (
        dispatcher.publishProducerNotification(
          secondaryId,
          'test.blocker',
          { data: 'x'.repeat(size) },
          { logDrop: false }
        )
      ) {
        // Shrinking frames leave less headroom than workspace.changed needs.
      }
    }

    const publish = vi.spyOn(dispatcher, 'publishProducerNotification')
    await patchSession({ activeTabId: null, tabsByWorktreePath: {}, terminalLayoutsByTabId: {} })
    await vi.waitFor(() =>
      expect(
        publish.mock.calls.some(
          ([clientId, method]) => clientId === secondaryId && method === 'workspace.changed'
        )
      ).toBe(true)
    )
    blocked = false
    for (const listener of Array.from(drainListeners)) {
      drainListeners.delete(listener)
      listener()
    }

    await vi.waitFor(() =>
      expect(
        (decodeJsonFrames(secondaryWritten) as { method?: string }[]).some(
          (frame) => frame.method === 'workspace.refreshRequired'
        )
      ).toBe(true)
    )
    expect(
      (decodeJsonFrames(secondaryWritten) as { method?: string }[]).some(
        (frame) => frame.method === 'workspace.changed'
      )
    ).toBe(false)
  })

  it('closes the client when even the control fallback cannot be admitted', async () => {
    let secondaryCloses = 0
    const secondaryId = dispatcher.attachClient(
      (data) => {
        void data
        return false
      },
      {
        writableLength: () => NODE_21_HIGH_WATER_MARK,
        writableHighWaterMark: () => NODE_21_HIGH_WATER_MARK,
        waitWriteDrain: () => {},
        close: () => {
          secondaryCloses++
        }
      }
    )
    for (let index = 0; index < DISPATCHER_CONTROL_QUEUE_MAX_FRAMES; index++) {
      dispatcher.notifyClient(secondaryId, 'test.control', { index })
    }
    expect(secondaryCloses).toBe(0)

    await patchSession({ title: 'x'.repeat(20_000) })

    await vi.waitFor(() => expect(secondaryCloses).toBe(1))
    expect(dispatcher.activeClientIds()).not.toContain(secondaryId)
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
})
