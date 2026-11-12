import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import '../unused-default-rpc-methods.test-fixture'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import '../../orchestration/db/contract-constants'
import '../../orchestration/db/messages/mailbox-routing-page'
import '../../orchestration/db/dispatch-row-writer'
import '../../orchestration/db/attempt-outcome-projection'

import { readRuntimeMetadata } from './runtime-metadata'

import { createLongPollServer as createServer } from './runtime-rpc-long-poll-server.test-fixture'
import {
  sendRequest,
  openFramedSession,
  sleep,
  waitFor,
  seedSupervisedAskWorkers
} from './runtime-rpc-test-harness'
import '../../orchestration/db/root-dispatch-test-fixture'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../../orca-runtime-tests/agent-transcript-pane-test-harness'

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeScanCacheModule>()),
  listWorktrees: (await getWorktreeOwnerMocks()).listWorktrees
}))

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeListingModule>()),
  listWorktreesStrict: (await getWorktreeOwnerMocks()).listWorktreesStrict
}))

const { getWorktreeOwnerMocks } = vi.hoisted(() => {
  function createWorktreeOwnerMocks() {
    return (async () =>
      (await import('./runtime-rpc-worktree-store-fixtures')).createWorktreeListingMocks())()
  }
  let fixture: ReturnType<typeof createWorktreeOwnerMocks> | undefined
  return { getWorktreeOwnerMocks: () => (fixture ??= createWorktreeOwnerMocks()) }
})

describe('OrcaRuntimeRpcServer', () => {
  it('rejects oversized RPC frames instead of buffering them indefinitely', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = createServer({ runtime, userDataPath })

    await server.start()

    const metadata = readRuntimeMetadata(userDataPath)
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = createConnection(metadata!.transports[0]!.endpoint)
      let buffer = ''
      socket.setEncoding('utf8')
      socket.once('error', reject)
      socket.on('data', (chunk: string) => {
        buffer += chunk
        const newlineIndex = buffer.indexOf('\n')
        if (newlineIndex === -1) {
          return
        }
        socket.end()
        resolve(JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>)
      })
      socket.on('connect', () => {
        socket.write(`${'x'.repeat(1024 * 1024 + 1)}\n`)
      })
    })

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'request_too_large'
      }
    })

    await server.stop()
  })

  // Use real socket keepalives/admission to catch flush/buffer regressions mocks miss (design §§3.1, 6).
  describe('long-poll transport (§3.1)', () => {
    it('releases terminal.wait long-poll slot when the client closes mid-wait', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const runtime = new OrcaRuntimeService()
      const server = createServer({
        runtime,
        userDataPath,
        keepaliveIntervalMs: 1000,
        longPollCap: 1
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-1',
            worktreeId: 'repo-1::/tmp/worktree-a',
            title: 'Terminal 1',
            activeLeafId: 'pane:1',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-1',
            worktreeId: 'repo-1::/tmp/worktree-a',
            leafId: 'pane:1',
            paneRuntimeId: 1,
            ptyId: 'pty-1'
          }
        ]
      })
      await server.start()

      try {
        const metadata = readRuntimeMetadata(userDataPath)
        const listResponse = await sendRequest(metadata!.transports[0]!.endpoint, {
          id: 'req_list',
          authToken: metadata!.authToken,
          method: 'terminal.list'
        })
        const handle = (
          listResponse.result as {
            terminals: { handle: string }[]
          }
        ).terminals[0]!.handle
        const endpoint = metadata!.transports[0]!.endpoint

        const session = openFramedSession(endpoint, {
          id: 'req_terminal_wait',
          authToken: metadata!.authToken,
          method: 'terminal.wait',
          params: { terminal: handle, for: 'exit', timeoutMs: 10_000 }
        })
        await waitFor(() => server['activeLongPolls'] === 1)

        session.socket.destroy()
        await session.done
        await waitFor(() => server['activeLongPolls'] === 0)

        const admitted = openFramedSession(endpoint, {
          id: 'req_terminal_wait_2',
          authToken: metadata!.authToken,
          method: 'terminal.wait',
          params: { terminal: handle, for: 'tui-idle', timeoutMs: 50 }
        })
        await admitted.done
        expect(admitted.frames.find((f) => f.ok !== undefined)).toMatchObject({
          id: 'req_terminal_wait_2',
          ok: false,
          error: { code: 'timeout' }
        })
      } finally {
        await server.stop()
      }
    })

    it('releases one same-Run wait slot when its client closes and keeps its sibling live', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const runtime = new OrcaRuntimeService()
      const db = new OrchestrationDb(':memory:')
      runtime.setOrchestrationDb(db)
      // A consuming check now requires a live pane; these transport tests only need it to block.
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => `tab_${handle}:leaf`)
      const run = db.createRun({
        objective: 'Concurrent Run waits',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab_term_coord:leaf'
      })
      const server = createServer({
        runtime,
        userDataPath,
        keepaliveIntervalMs: 1000,
        longPollCap: 2
      })
      await server.start()

      try {
        const metadata = readRuntimeMetadata(userDataPath)
        const endpoint = metadata!.transports[0]!.endpoint
        const openRunWait = (id: string) =>
          openFramedSession(endpoint, {
            id,
            authToken: metadata!.authToken,
            method: 'orchestration.check',
            params: { terminal: 'term_coord', run: run.id, wait: true, timeoutMs: 10_000 }
          })

        // Fill the cap with two waits on the same Run inbox.
        const a = openRunWait('req_a')
        const b = openRunWait('req_b')
        await waitFor(() => server['activeLongPolls'] === 2)

        a.socket.destroy()
        await a.done
        await waitFor(() => server['activeLongPolls'] === 1)

        // The freed slot must admit another wait on the same inbox.
        const c = openRunWait('req_c')
        await waitFor(() => server['activeLongPolls'] === 2)
        db.insertMessage({ from: 'term_worker', to: `run:${run.id}`, subject: 'go', runId: run.id })
        runtime.notifyMessageArrived(`run:${run.id}`)
        await Promise.all([b.done, c.done])
        const results = [b, c].map((s) => s.frames.find((f) => f.ok !== undefined)?.result)
        const batch = { deliveryId: expect.stringMatching(/^delivery_/), count: 1 }
        expect(results).toMatchObject([batch, batch])
        expect(db.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get()).toEqual({ n: 1 })
        await waitFor(() => server['activeLongPolls'] === 0)
      } finally {
        db.close()
        await server.stop()
      }
    })

    it('destroys active Unix sockets and cancels pending composer readiness when the runtime stops', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'shell',
        foregroundProcess: 'bash',
        data: ''
      })
      const server = createServer({ runtime, userDataPath })
      vi.spyOn(server['dispatcher'], 'dispatch').mockImplementation(async (_request, context) => {
        await runtime.waitForFreshWorkerComposer(handle, 'claude', 60_000, {
          signal: context?.signal
        })
        throw new Error('unexpected_composer_ready')
      })
      await server.start()
      try {
        const metadata = readRuntimeMetadata(userDataPath)!
        const session = openFramedSession(metadata.transports[0]!.endpoint, {
          id: 'req_stop',
          authToken: metadata.authToken,
          method: 'orchestration.check',
          params: { terminal: 'term_stop', wait: true, timeoutMs: 10_000 }
        })
        await waitFor(() => runtime['terminalWaiters'].forPty(TRANSCRIPT_PANE_PTY_ID).length === 1)
        await server.stop()
        await session.done
        await waitFor(() => server['activeLongPolls'] === 0)
        expect(session.socket.destroyed).toBe(true)
        expect(runtime['terminalWaiters'].forPty(TRANSCRIPT_PANE_PTY_ID)).toHaveLength(0)
        expect(
          runtime['terminalStreamConsumers']['dataListeners'].get(TRANSCRIPT_PANE_PTY_ID)
        ).toBeUndefined()
      } finally {
        await server.stop()
      }
    })

    it('reserves long-poll headroom for terminal.wait when orchestration.ask floods', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const runtime = new OrcaRuntimeService()
      const db = new OrchestrationDb(':memory:')
      runtime.setOrchestrationDb(db)
      // A consuming check now requires a live pane; these transport tests only need it to block.
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => `tab_${handle}:leaf`)
      seedSupervisedAskWorkers(db, ['term_w0', 'term_w1', 'term_w2', 'term_w3'])
      // Ask sub-cap is half the total: cap 4 admits only two asks.
      const server = createServer({
        runtime,
        userDataPath,
        keepaliveIntervalMs: 1000,
        longPollCap: 4
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-1',
            worktreeId: 'repo-1::/tmp/worktree-a',
            title: 'Terminal 1',
            activeLeafId: 'pane:1',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-1',
            worktreeId: 'repo-1::/tmp/worktree-a',
            leafId: 'pane:1',
            paneRuntimeId: 1,
            ptyId: 'pty-1'
          }
        ]
      })
      await server.start()

      const asks: ReturnType<typeof openFramedSession>[] = []
      try {
        const metadata = readRuntimeMetadata(userDataPath)
        const endpoint = metadata!.transports[0]!.endpoint
        const listResponse = await sendRequest(endpoint, {
          id: 'req_list',
          authToken: metadata!.authToken,
          method: 'terminal.list'
        })
        const handle = (listResponse.result as { terminals: { handle: string }[] }).terminals[0]!
          .handle

        // Distinct senders keep four pending asks from waking each other.
        for (let i = 0; i < 4; i++) {
          asks.push(
            openFramedSession(endpoint, {
              id: `req_ask_${i}`,
              authToken: metadata!.authToken,
              method: 'orchestration.ask',
              params: {
                from: `term_w${i}`,
                to: 'term_coord',
                question: 'proceed?',
                timeoutMs: 10_000
              }
            })
          )
        }
        // Let every ask reach the admission fence before probing the reserved half.
        await waitFor(() => server['activeLongPolls'] >= 2)
        await sleep(100)

        // The reserved half still admits a terminal.wait from any other client.
        const admitted = openFramedSession(endpoint, {
          id: 'req_terminal_wait',
          authToken: metadata!.authToken,
          method: 'terminal.wait',
          params: { terminal: handle, for: 'tui-idle', timeoutMs: 50 }
        })
        await admitted.done
        expect(admitted.frames.find((f) => f.ok !== undefined)).toMatchObject({
          id: 'req_terminal_wait',
          ok: false,
          error: { code: 'timeout' }
        })

        // …and a check --wait too, which shares the same reserved class.
        const check = openFramedSession(endpoint, {
          id: 'req_check_wait',
          authToken: metadata!.authToken,
          method: 'orchestration.check',
          params: { terminal: 'term_other', wait: true, timeoutMs: 100 }
        })
        await check.done
        expect(check.frames.find((f) => f.ok !== undefined)).toMatchObject({
          id: 'req_check_wait',
          ok: true
        })

        // Overflow asks are shed, not queued: the sub-cap holds at half the budget.
        expect(server['activeAskLongPolls']).toBe(2)
        const shed = asks
          .map((a) => a.frames.find((f) => f.ok !== undefined))
          .filter((f) => f !== undefined)
        expect(shed).toHaveLength(2)
        expect(shed[0]).toMatchObject({ ok: false, error: { code: 'runtime_busy' } })
      } finally {
        for (const ask of asks) {
          ask.socket.destroy()
        }
        await Promise.all(asks.map((ask) => ask.done))
        db.close()
        await server.stop()
      }
    })
  })
})
