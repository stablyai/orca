import './rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { readRuntimeMetadata } from './runtime-metadata'
import { isRuntimeLongPoll } from './runtime-rpc/runtime-rpc-long-poll'
import { createLongPollServer as createServer } from './runtime-rpc-long-poll-server.test-fixture'
import { sendRequest, openFramedSession, sleep, waitFor } from './runtime-rpc-test-harness'
import { createRootDispatch } from './orchestration/db/root-dispatch-test-fixture'

// Records each dispatched request's abort signal by request id.
function recordDispatchSignals(
  server: ReturnType<typeof createServer>
): Map<string, AbortSignal | undefined> {
  const signals = new Map<string, AbortSignal | undefined>()
  const dispatcher = server['dispatcher']
  const originalDispatch = dispatcher.dispatch.bind(dispatcher)
  vi.spyOn(dispatcher, 'dispatch').mockImplementation(async (request, context) => {
    signals.set(request.id, context?.signal)
    return originalDispatch(request, context)
  })
  return signals
}

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

describe('OrcaRuntimeRpcServer', () => {
  it('classifies worker-start as a keepalive-backed long poll', () => {
    expect(
      isRuntimeLongPoll({
        id: 'req_worker_start',
        authToken: 'token',
        method: 'orchestration.workerStart',
        params: { task: 'task_1', timeoutMs: 60_000 }
      })
    ).toBe(true)
  })

  it.each(['agent.launch', 'agent.launchReplay'])(
    'keeps a prompted %s alive while it waits for the agent to be ready',
    (method) => {
      const prompt = { text: 'fix the build', delivery: 'submit' }
      expect(
        isRuntimeLongPoll({
          id: 'req_launch',
          authToken: 'token',
          method,
          params: { prompt }
        })
      ).toBe(true)
      // An existing workspace without a prompt remains a short call.
      expect(isRuntimeLongPoll({ id: 'req_launch', authToken: 'token', method, params: {} })).toBe(
        false
      )
    }
  )

  it.each(['agent.launch', 'agent.launchReplay'])(
    'keeps unprompted %s workspace setup alive',
    (method) => {
      expect(
        isRuntimeLongPoll({
          id: 'req_setup',
          authToken: 'token',
          method,
          params: {
            target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } }
          }
        })
      ).toBe(true)
      expect(
        isRuntimeLongPoll({
          id: 'req_existing',
          authToken: 'token',
          method,
          params: { target: { kind: 'existing', worktree: 'id:wt-7' } }
        })
      ).toBe(false)
    }
  )

  it('keeps agent-prompt submission sockets alive during verification', () => {
    expect(
      isRuntimeLongPoll({
        id: 'req_prompt',
        authToken: 'token',
        method: 'terminal.send',
        params: { agentPrompt: true }
      })
    ).toBe(true)
    expect(
      isRuntimeLongPoll({
        id: 'req_direct',
        authToken: 'token',
        method: 'terminal.send',
        params: { agentPrompt: false }
      })
    ).toBe(false)
  })

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

  // Why: §6 tests for the transport keepalive + long-poll abort path in §3.1.
  // Exercise the real socket (not a mock) so we catch buffer/flush regressions
  // that a unit-level test would miss.
  describe('long-poll transport (§3.1)', () => {
    it.each(['agent.launch', 'agent.launchReplay'])(
      'emits keepalives over the socket while unprompted %s setup blocks',
      async (method) => {
        const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
        const runtime = new OrcaRuntimeService()
        const server = createServer({ runtime, userDataPath, keepaliveIntervalMs: 30 })
        vi.spyOn(server['dispatcher'], 'dispatch').mockImplementation(async (request) => {
          await sleep(120)
          return {
            id: request.id,
            ok: true,
            result: {},
            _meta: { runtimeId: runtime.getRuntimeId() }
          }
        })
        await server.start()
        try {
          const metadata = readRuntimeMetadata(userDataPath)
          const session = openFramedSession(metadata!.transports[0]!.endpoint, {
            id: 'req_setup',
            authToken: metadata!.authToken,
            method,
            params: {
              target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } }
            }
          })
          await session.done
          expect(
            session.frames.filter((frame) => frame._keepalive === true).length
          ).toBeGreaterThanOrEqual(2)
          expect(session.frames.filter((frame) => frame.ok !== undefined)).toHaveLength(1)
        } finally {
          await server.stop()
        }
      }
    )

    it('emits keepalives while orchestration.workerStart blocks', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const runtime = new OrcaRuntimeService()
      const server = createServer({
        runtime,
        userDataPath,
        keepaliveIntervalMs: 30
      })
      const dispatch = server['dispatcher']
      vi.spyOn(dispatch, 'dispatch').mockImplementation(async (request) => {
        await sleep(120)
        return {
          id: request.id,
          ok: true,
          result: { dispatch: { id: 'dispatch_1' } },
          _meta: { runtimeId: runtime.getRuntimeId() }
        }
      })
      await server.start()

      try {
        const metadata = readRuntimeMetadata(userDataPath)
        const session = openFramedSession(metadata!.transports[0]!.endpoint, {
          id: 'req_worker_start',
          authToken: metadata!.authToken,
          method: 'orchestration.workerStart',
          params: { task: 'task_1', timeoutMs: 60_000 }
        })
        await session.done

        expect(
          session.frames.filter((frame) => frame._keepalive === true).length
        ).toBeGreaterThanOrEqual(2)
        expect(session.frames.filter((frame) => frame.ok !== undefined)).toHaveLength(1)
      } finally {
        await server.stop()
      }
    })

    it('emits keepalive frames while a check --wait handler blocks', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const runtime = new OrcaRuntimeService()
      const db = new OrchestrationDb(':memory:')
      runtime.setOrchestrationDb(db)
      // A consuming check now requires a live pane; these transport tests only need it to block.
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => `tab_${handle}:leaf`)
      // Why: 50ms keepalive lets us collect ≥3 frames within a 300ms wait
      // window without slowing the suite.
      const server = createServer({
        runtime,
        userDataPath,
        keepaliveIntervalMs: 50
      })
      await server.start()

      try {
        const metadata = readRuntimeMetadata(userDataPath)
        const session = openFramedSession(metadata!.transports[0]!.endpoint, {
          id: 'req_wait',
          authToken: metadata!.authToken,
          method: 'orchestration.check',
          params: {
            terminal: 'term_nobody',
            wait: true,
            timeoutMs: 300
          }
        })
        await session.done

        const keepalives = session.frames.filter((f) => f._keepalive === true)
        const terminals = session.frames.filter((f) => f.ok !== undefined)
        expect(terminals).toHaveLength(1)
        expect(terminals[0]).toMatchObject({ id: 'req_wait', ok: true })
        // Why: 300ms wait with 50ms keepalive → expect roughly 5 keepalives;
        // assert ≥3 to tolerate scheduler jitter without flaking.
        expect(keepalives.length).toBeGreaterThanOrEqual(3)
      } finally {
        db.close()
        await server.stop()
      }
    })

    it('emits keepalive frames while orchestration.ask blocks for a reply', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const runtime = new OrcaRuntimeService()
      const db = new OrchestrationDb(':memory:')
      runtime.setOrchestrationDb(db)
      // A consuming check now requires a live pane; these transport tests only need it to block.
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => `tab_${handle}:leaf`)
      const askerPaneKey = 'tab_asker:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_asker' ? askerPaneKey : null
      )
      const run = db.createRun({
        objective: 'Keepalive test',
        coordinatorHandle: 'term_nobody',
        coordinatorPaneKey: 'tab_coord:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      })
      const task = db.createTask({ spec: 'Wait for an answer', runId: run.id })
      createRootDispatch(db, task.id, 'term_asker', askerPaneKey)
      const server = createServer({
        runtime,
        userDataPath,
        keepaliveIntervalMs: 50
      })
      await server.start()

      try {
        const metadata = readRuntimeMetadata(userDataPath)
        // Why: no reply is ever sent, so ask blocks the full window on the same
        // hold-the-socket path check --wait uses. Without ask in the long-poll
        // set the 30s idle timer would tear this down before it keepalives.
        const session = openFramedSession(metadata!.transports[0]!.endpoint, {
          id: 'req_ask',
          authToken: metadata!.authToken,
          method: 'orchestration.ask',
          params: {
            to: 'term_nobody',
            from: 'term_asker',
            question: 'ping?',
            timeoutMs: 300
          }
        })
        await session.done

        const keepalives = session.frames.filter((f) => f._keepalive === true)
        const terminals = session.frames.filter((f) => f.ok !== undefined)
        expect(terminals).toHaveLength(1)
        expect(terminals[0]).toMatchObject({
          id: 'req_ask',
          ok: true,
          result: { timedOut: true }
        })
        expect(keepalives.length).toBeGreaterThanOrEqual(3)
      } finally {
        db.close()
        await server.stop()
      }
    })

    it('emits keepalive frames while terminal.wait blocks and returns its structured timeout', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const runtime = new OrcaRuntimeService()
      const server = createServer({
        runtime,
        userDataPath,
        keepaliveIntervalMs: 30
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
      runtime.onPtyData('pty-1', 'Starting MCP servers...\n', 123)
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

        const session = openFramedSession(metadata!.transports[0]!.endpoint, {
          id: 'req_terminal_wait',
          authToken: metadata!.authToken,
          method: 'terminal.wait',
          params: {
            terminal: handle,
            for: 'tui-idle',
            timeoutMs: 150
          }
        })
        await session.done

        const keepalives = session.frames.filter((f) => f._keepalive === true)
        const terminalFrames = session.frames.filter((f) => f.ok !== undefined)
        expect(keepalives.length).toBeGreaterThanOrEqual(2)
        expect(terminalFrames).toHaveLength(1)
        expect(terminalFrames[0]).toMatchObject({
          id: 'req_terminal_wait',
          ok: false,
          error: { code: 'timeout' }
        })
      } finally {
        await server.stop()
      }
    })

    it('emits keepalive frames while agent-prompt verification blocks', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const runtime = new OrcaRuntimeService()
      const server = createServer({
        runtime,
        userDataPath,
        keepaliveIntervalMs: 30
      })
      const dispatch = server['dispatcher']
      vi.spyOn(dispatch, 'dispatch').mockImplementation(async (request) => {
        await sleep(120)
        return {
          id: request.id,
          ok: true,
          result: { send: { accepted: true } },
          _meta: { runtimeId: runtime.getRuntimeId() }
        }
      })
      await server.start()

      try {
        const metadata = readRuntimeMetadata(userDataPath)
        const session = openFramedSession(metadata!.transports[0]!.endpoint, {
          id: 'req_prompt',
          authToken: metadata!.authToken,
          method: 'terminal.send',
          params: { agentPrompt: true }
        })
        await session.done

        expect(
          session.frames.filter((frame) => frame._keepalive === true).length
        ).toBeGreaterThanOrEqual(2)
        expect(session.frames.filter((frame) => frame.ok !== undefined)).toHaveLength(1)
      } finally {
        await server.stop()
      }
    })

    it('aborts terminal.wait when the client closes mid-wait', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const runtime = new OrcaRuntimeService()
      const server = createServer({
        runtime,
        userDataPath,
        keepaliveIntervalMs: 1000
      })
      const signals = recordDispatchSignals(server)
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
        await waitFor(() => signals.has('req_terminal_wait'))
        expect(signals.get('req_terminal_wait')?.aborted).toBe(false)

        session.socket.destroy()
        await session.done
        await waitFor(() => signals.get('req_terminal_wait')?.aborted === true)
      } finally {
        await server.stop()
      }
    })

    it('aborts only the closed client when check --wait clients close mid-wait', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const runtime = new OrcaRuntimeService()
      const db = new OrchestrationDb(':memory:')
      runtime.setOrchestrationDb(db)
      // A consuming check now requires a live pane; these transport tests only need it to block.
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => `tab_${handle}:leaf`)
      const server = createServer({
        runtime,
        userDataPath,
        keepaliveIntervalMs: 1000
      })
      const signals = recordDispatchSignals(server)
      await server.start()

      try {
        const metadata = readRuntimeMetadata(userDataPath)
        const endpoint = metadata!.transports[0]!.endpoint

        const a = openFramedSession(endpoint, {
          id: 'req_a',
          authToken: metadata!.authToken,
          method: 'orchestration.check',
          params: { terminal: 'term_a', wait: true, timeoutMs: 10_000 }
        })
        const b = openFramedSession(endpoint, {
          id: 'req_b',
          authToken: metadata!.authToken,
          method: 'orchestration.check',
          params: { terminal: 'term_b', wait: true, timeoutMs: 10_000 }
        })
        await waitFor(() => signals.has('req_a') && signals.has('req_b'))

        a.socket.destroy()
        await a.done
        await waitFor(() => signals.get('req_a')?.aborted === true)
        expect(signals.get('req_b')?.aborted).toBe(false)

        b.socket.destroy()
        await b.done
        await waitFor(() => signals.get('req_b')?.aborted === true)
      } finally {
        db.close()
        await server.stop()
      }
    })

    it('destroys active Unix socket connections when the runtime stops', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const runtime = new OrcaRuntimeService()
      const db = new OrchestrationDb(':memory:')
      runtime.setOrchestrationDb(db)
      // A consuming check now requires a live pane; these transport tests only need it to block.
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => `tab_${handle}:leaf`)
      const server = createServer({
        runtime,
        userDataPath,
        keepaliveIntervalMs: 1000
      })
      const signals = recordDispatchSignals(server)
      await server.start()

      try {
        const metadata = readRuntimeMetadata(userDataPath)
        const endpoint = metadata!.transports[0]!.endpoint

        const session = openFramedSession(endpoint, {
          id: 'req_stop',
          authToken: metadata!.authToken,
          method: 'orchestration.check',
          params: { terminal: 'term_stop', wait: true, timeoutMs: 10_000 }
        })
        await waitFor(() => signals.has('req_stop'))

        const stopResult = await Promise.race([
          server.stop().then(() => 'stopped'),
          sleep(500).then(() => 'timeout')
        ])

        expect(stopResult).toBe('stopped')
        await session.done
        await waitFor(() => signals.get('req_stop')?.aborted === true)
        expect(session.socket.destroyed).toBe(true)
      } finally {
        db.close()
        await server.stop()
      }
    })

    it('does not emit keepalive frames for short RPCs', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const runtime = new OrcaRuntimeService()
      const server = createServer({ runtime, userDataPath, keepaliveIntervalMs: 10 })
      const originalDispatch = server['dispatcher'].dispatch.bind(server['dispatcher'])
      vi.spyOn(server['dispatcher'], 'dispatch').mockImplementation(async (request, context) => {
        // Keep the real response pending long enough to expose an incorrectly armed timer.
        await sleep(50)
        return originalDispatch(request, context)
      })
      await server.start()

      try {
        const metadata = readRuntimeMetadata(userDataPath)
        const session = openFramedSession(metadata!.transports[0]!.endpoint, {
          id: 'req_short',
          authToken: metadata!.authToken,
          method: 'status.get'
        })
        await session.done

        const terminals = session.frames.filter((f) => f.ok !== undefined)
        expect(terminals).toHaveLength(1)
        expect(terminals[0]).toMatchObject({ id: 'req_short', ok: true })
        expect(session.frames.filter((f) => f._keepalive === true)).toHaveLength(0)
      } finally {
        await server.stop()
      }
    })

    it('returns an internal_error envelope when the dispatcher throws', async () => {
      // Why: handlers are designed to return error envelopes, never to throw,
      // but a bug somewhere in the RPC stack (e.g. JSON.stringify choking on
      // a response with circular refs) must still produce a terminal frame.
      // Without the `.catch` on handleMessage's promise, a throw would leave
      // the client hanging until the 30s idle timer and leak the dispatch's
      // AbortController in the transport's in-flight set.
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const runtime = new OrcaRuntimeService()
      const server = createServer({ runtime, userDataPath })
      await server.start()

      // Force the dispatcher to throw a non-envelope error.
      const originalDispatch = server['dispatcher'].dispatch.bind(server['dispatcher'])
      server['dispatcher'].dispatch = vi.fn().mockRejectedValue(new Error('boom'))

      try {
        const metadata = readRuntimeMetadata(userDataPath)
        const response = await sendRequest(metadata!.transports[0]!.endpoint, {
          id: 'req_throw',
          authToken: metadata!.authToken,
          method: 'status.get'
        })
        expect(response).toMatchObject({
          id: 'req_throw',
          ok: false,
          error: { code: 'internal_error', message: 'boom' }
        })
      } finally {
        server['dispatcher'].dispatch = originalDispatch
        await server.stop()
      }
    })
  })
})
