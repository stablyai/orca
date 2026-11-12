import '../../pty-subprocess/testing/mock-descendant-sweep'
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DaemonPtyAdapter } from '../../providers/adapter/daemon-pty-adapter'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from '../../providers/adapter/testing/daemon-pty-adapter-test-harness'
import { answerDaemonControlRequest } from '../daemon-control-request'
import { answerDaemonHistoryRequest } from '../daemon-history-requests'
import { HISTORY_READ_CONSUMERS } from '../../history/journal/terminal-history-read-admission'
import type { GetSnapshotRequest } from '../../protocol/daemon-rpc-contract'
import { requestDaemonRpc } from '../../transport/client/daemon-client-rpc-request'
import { DaemonPendingRequests } from '../../transport/client/daemon-client-pending-requests'

let harness: Awaited<ReturnType<typeof startDaemonAdapterHarness>> | undefined
let adapter: DaemonPtyAdapter | undefined

afterEach(async () => {
  await adapter?.disconnectOnly()
  adapter?.dispose()
  harness?.adapter.dispose()
  await harness?.server.shutdown()
  if (harness) {
    rmSync(harness.dir, { recursive: true, force: true })
  }
  harness = undefined
  adapter = undefined
})

/** A control socket whose writes stay buffered until the test settles them. */
function slowSocket() {
  const writes: { line: string; settle: () => void }[] = []
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false,
    write: (line: string, settle: () => void) => {
      writes.push({ line, settle })
      return false
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reply path uses only write, destroyed and close events.
  return { socket: socket as unknown as Socket, writes }
}

/** One live host-owned terminal, its host, and deep requests answered through the real writer. */
async function openDeepOwnership() {
  let child = createMockSubprocess()
  harness = await startDaemonAdapterHarness(
    () => (child = createMockSubprocess()),
    {},
    {
      hostHistory: true
    }
  )
  adapter = new DaemonPtyAdapter({
    socketPath: harness.socketPath,
    tokenPath: harness.tokenPath,
    historyPath: join(harness.dir, 'history')
  })
  const spawned = await adapter.spawn({ sessionId: 'deep-owned', cols: 80, rows: 24, cwd: '/tmp' })
  child._simulateData('OWNED_ROW\r\n')
  const host = harness.server.host
  const { socket, writes } = slowSocket()
  let next = 0
  const ask = async (payload: Partial<GetSnapshotRequest['payload']> = {}): Promise<void> => {
    const request: GetSnapshotRequest = {
      id: `deep-${(next += 1)}`,
      type: 'getSnapshot',
      payload: { sessionId: spawned.id, scrollbackRows: 5000, ...payload }
    }
    await answerDaemonControlRequest(
      socket,
      request,
      () => answerDaemonHistoryRequest(host, request, socket),
      () => {}
    )
  }
  return { spawned, child: () => child, writes, ask }
}

describe('deep-history replies through the actual outer writer', () => {
  // CR1: a refused deep read used to write an unowned frame beyond the 64 owned replies.
  it('writes nothing for a refused read and serves again once a reply settles', async () => {
    const { writes, ask } = await openDeepOwnership()

    for (let index = 0; index < HISTORY_READ_CONSUMERS; index += 1) {
      await ask()
    }
    expect(writes).toHaveLength(HISTORY_READ_CONSUMERS)
    expect(writes.every(({ line }) => line.includes('OWNED_ROW'))).toBe(true)
    await ask()
    await ask()
    expect(writes).toHaveLength(HISTORY_READ_CONSUMERS)

    writes[0]!.settle()
    await ask({ remainingBudgetMs: 5_000 })
    expect(writes).toHaveLength(HISTORY_READ_CONSUMERS + 1)
    expect(JSON.parse(writes.at(-1)!.line)).toMatchObject({
      ok: true,
      payload: { history: { kind: expect.stringMatching(/^(origin|fold)$/) } }
    })
    expect(writes.at(-1)!.line).toContain('OWNED_ROW')
  }, 30_000)

  // CR1: a deep read for an exited ID or a replaced incarnation used to skip admission entirely.
  it('owns missing and stale-owner deep replies like any other, while live0 stays independent', async () => {
    const { spawned, child, writes, ask } = await openDeepOwnership()
    const stale = spawned.incarnationId!
    child()._simulateExit(0)
    await waitFor(() => harness!.server.host.historyJournals?.live(spawned.id) === undefined)
    await adapter!.spawn({ sessionId: spawned.id, cols: 80, rows: 24, cwd: '/tmp' })
    child()._simulateData('SUCCESSOR_ROW\r\n')

    for (let index = 0; index < HISTORY_READ_CONSUMERS - 1; index += 1) {
      await ask()
    }
    // One ticket left: a stale-owner answer takes it and holds it until its write settles.
    await ask({ expectedIncarnationId: stale })
    expect(JSON.parse(writes.at(-1)!.line)).toMatchObject({
      ok: true,
      payload: { snapshot: null, history: { kind: 'unavailable' } }
    })
    const held = writes.length
    await ask({ expectedIncarnationId: stale })
    await ask({ sessionId: 'never-existed' })
    expect(writes).toHaveLength(held)
    // The live window is a separate operation, answered while every deep ticket is held.
    await ask({ scrollbackRows: 0 })
    expect(writes).toHaveLength(held + 1)
    expect(writes.at(-1)!.line).toContain('SUCCESSOR_ROW')

    writes[held - 1]!.settle()
    await ask()
    expect(writes).toHaveLength(held + 2)
    expect(writes.at(-1)!.line).toContain('SUCCESSOR_ROW')
    adapter!.write(spawned.id, 'still-typing')
    await waitFor(() => child().write.mock.calls.some(([data]) => data === 'still-typing'))
  }, 30_000)

  // The caller's remaining wait travels with a deep read, so the daemon stops by the same time.
  it('sends the caller budget with a deep snapshot request', async () => {
    const lines: string[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the request path only writes the encoded line.
    const socket = { write: (line: string) => lines.push(line) } as unknown as Socket
    const reply = requestDaemonRpc({
      socket,
      pendingRequests: new DaemonPendingRequests(),
      id: 'budgeted',
      type: 'getSnapshot',
      payload: { sessionId: 'deep-owned', scrollbackRows: 5000 },
      timeoutMs: 40,
      unmatchedCancelGraceMs: 0,
      onCreateCancellationFailure: () => {},
      settleCreateCancellation: async () => ({ canceled: false })
    })
    await expect(reply).rejects.toThrow()
    expect(JSON.parse(lines[0]!).payload).toEqual({
      sessionId: 'deep-owned',
      scrollbackRows: 5000,
      remainingBudgetMs: 40
    })
  })
})
