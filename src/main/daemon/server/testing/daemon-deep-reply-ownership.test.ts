import '../../pty-subprocess/testing/mock-descendant-sweep'
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DaemonPtyAdapter } from '../../providers/adapter/daemon-pty-adapter'
import {
  createMockSubprocess,
  startDaemonAdapterHarness
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

describe('deep-history replies through the actual outer writer', () => {
  // CR1: a refused deep read used to write an unowned frame beyond the 64 owned replies.
  it('writes nothing for a refused read and serves again once a reply settles', async () => {
    const child = createMockSubprocess()
    harness = await startDaemonAdapterHarness(() => child, {}, { hostHistory: true })
    adapter = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath,
      historyPath: join(harness.dir, 'history')
    })
    const { id } = await adapter.spawn({ sessionId: 'deep-owned', cols: 80, rows: 24, cwd: '/tmp' })
    child._simulateData('OWNED_ROW\r\n')
    const host = harness.server.host
    const { socket, writes } = slowSocket()
    let next = 0
    const ask = async (remainingBudgetMs?: number): Promise<void> => {
      const request: GetSnapshotRequest = {
        id: `deep-${(next += 1)}`,
        type: 'getSnapshot',
        payload: {
          sessionId: id,
          scrollbackRows: 5000,
          ...(remainingBudgetMs !== undefined ? { remainingBudgetMs } : {})
        }
      }
      await answerDaemonControlRequest(
        socket,
        request,
        () => answerDaemonHistoryRequest(host, request, socket),
        () => {}
      )
    }

    for (let index = 0; index < HISTORY_READ_CONSUMERS; index += 1) {
      await ask()
    }
    expect(writes).toHaveLength(HISTORY_READ_CONSUMERS)
    expect(writes.every(({ line }) => line.includes('OWNED_ROW'))).toBe(true)
    await ask()
    await ask()
    expect(writes).toHaveLength(HISTORY_READ_CONSUMERS)

    writes[0]!.settle()
    await ask(5_000)
    expect(writes).toHaveLength(HISTORY_READ_CONSUMERS + 1)
    expect(JSON.parse(writes.at(-1)!.line)).toMatchObject({
      ok: true,
      payload: { history: { kind: expect.stringMatching(/^(origin|fold)$/) } }
    })
    expect(writes.at(-1)!.line).toContain('OWNED_ROW')
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
