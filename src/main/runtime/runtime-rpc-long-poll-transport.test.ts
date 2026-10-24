import './rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { readRuntimeMetadata } from './runtime-metadata'
import { classifyRuntimeLongPoll } from './runtime-rpc/runtime-rpc-long-poll'
import { createLongPollServer as createServer } from './runtime-rpc-long-poll-server.test-fixture'
import {
  sendRequest,
  openFramedSession,
  sleep,
  waitFor,
  seedSupervisedAskWorkers
} from './runtime-rpc-test-harness'
import { createRootDispatch } from './orchestration/db/root-dispatch-test-fixture'

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
      classifyRuntimeLongPoll({
        id: 'req_worker_start',
        authToken: 'token',
        method: 'orchestration.workerStart',
        params: { task: 'task_1', timeoutMs: 60_000 }
      })
    ).toBe('wait')
  })

  it.each(['agent.launch', 'agent.launchReplay'])(
    'keeps a prompted %s alive while it waits for the agent to be ready',
    (method) => {
      const prompt = { text: 'fix the build', delivery: 'submit' }
      expect(
        classifyRuntimeLongPoll({
          id: 'req_launch',
          authToken: 'token',
          method,
          params: { prompt }
        })
      ).toBe('wait')
      // An existing workspace without a prompt remains a short call.
      expect(
        classifyRuntimeLongPoll({ id: 'req_launch', authToken: 'token', method, params: {} })
      ).toBeNull()
    }
  )

  it.each(['agent.launch', 'agent.launchReplay'])(
    'keeps unprompted %s workspace setup alive',
    (method) => {
      expect(
        classifyRuntimeLongPoll({
          id: 'req_setup',
          authToken: 'token',
          method,
          params: {
            target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } }
          }
        })
      ).toBe('wait')
      expect(
        classifyRuntimeLongPoll({
          id: 'req_existing',
          authToken: 'token',
          method,
          params: { target: { kind: 'existing', worktree: 'id:wt-7' } }
        })
      ).toBeNull()
    }
  )

  it('keeps agent-prompt submission sockets alive during verification', () => {
    expect(
      classifyRuntimeLongPoll({
        id: 'req_prompt',
        authToken: 'token',
        method: 'terminal.send',
        params: { agentPrompt: true }
      })
    ).toBe('wait')
    expect(
      classifyRuntimeLongPoll({
        id: 'req_direct',
        authToken: 'token',
        method: 'terminal.send',
        params: { agentPrompt: false }
      })
    ).toBeNull()
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

  // Use real socket keepalives/admission to catch flush/buffer regressions mocks miss (design §§3.1, 6).
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
      // Use 50ms keepalive to observe several frames during a 300ms wait.
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
        // Expect at least three 50ms frames in 300ms, leaving scheduler slack.
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
        // Unanswered ask must keepalive like check --wait; otherwise idle timeout kills the long poll.
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

    it('releases long-poll slot when client closes mid-wait', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const runtime = new OrcaRuntimeService()
      const db = new OrchestrationDb(':memory:')
      runtime.setOrchestrationDb(db)
      // A consuming check now requires a live pane; these transport tests only need it to block.
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => `tab_${handle}:leaf`)
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

        // Fill admission with two 10s waits, then disconnect one.
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
        await sleep(100)
        expect(server['activeLongPolls']).toBe(2)

        a.socket.destroy()
        await a.done
        await sleep(50)
        expect(server['activeLongPolls']).toBe(1)

        const c = openFramedSession(endpoint, {
          id: 'req_c',
          authToken: metadata!.authToken,
          method: 'orchestration.check',
          params: { terminal: 'term_c', wait: true, timeoutMs: 100 }
        })
        await c.done
        const cTerminal = c.frames.find((f) => f.ok !== undefined)
        expect(cTerminal).toMatchObject({ ok: true, id: 'req_c' })

        b.socket.destroy()
        await b.done
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
        keepaliveIntervalMs: 1000,
        longPollCap: 1
      })
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
        await waitFor(() => server['activeLongPolls'] === 1)

        const stopResult = await Promise.race([
          server.stop().then(() => 'stopped'),
          sleep(500).then(() => 'timeout')
        ])

        expect(stopResult).toBe('stopped')
        await session.done
        await waitFor(() => server['activeLongPolls'] === 0)
        expect(session.socket.destroyed).toBe(true)
      } finally {
        db.close()
        await server.stop()
      }
    })

    it('responds runtime_busy once the long-poll cap is saturated', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const runtime = new OrcaRuntimeService()
      const db = new OrchestrationDb(':memory:')
      runtime.setOrchestrationDb(db)
      // A consuming check now requires a live pane; these transport tests only need it to block.
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => `tab_${handle}:leaf`)
      const server = createServer({
        runtime,
        userDataPath,
        keepaliveIntervalMs: 1000,
        longPollCap: 1
      })
      await server.start()

      try {
        const metadata = readRuntimeMetadata(userDataPath)
        const endpoint = metadata!.transports[0]!.endpoint

        const a = openFramedSession(endpoint, {
          id: 'req_a',
          authToken: metadata!.authToken,
          method: 'orchestration.check',
          params: { terminal: 'term_a', wait: true, timeoutMs: 5_000 }
        })
        await sleep(100)
        expect(server['activeLongPolls']).toBe(1)

        const overflow = await sendRequest(endpoint, {
          id: 'req_overflow',
          authToken: metadata!.authToken,
          method: 'orchestration.check',
          params: { terminal: 'term_b', wait: true, timeoutMs: 5_000 }
        })
        expect(overflow).toMatchObject({
          id: 'req_overflow',
          ok: false,
          error: { code: 'runtime_busy' }
        })
        expect(server['activeLongPolls']).toBe(1)

        const short = await sendRequest(endpoint, {
          id: 'req_short',
          authToken: metadata!.authToken,
          method: 'status.get'
        })
        expect(short).toMatchObject({ id: 'req_short', ok: true })

        a.socket.destroy()
        await a.done
      } finally {
        db.close()
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

    it('keeps the full cap available to terminal.wait and check --wait', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const runtime = new OrcaRuntimeService()
      const db = new OrchestrationDb(':memory:')
      runtime.setOrchestrationDb(db)
      // A consuming check now requires a live pane; these transport tests only need it to block.
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => `tab_${handle}:leaf`)
      const server = createServer({
        runtime,
        userDataPath,
        keepaliveIntervalMs: 1000,
        longPollCap: 4
      })
      await server.start()

      const waits: ReturnType<typeof openFramedSession>[] = []
      try {
        const metadata = readRuntimeMetadata(userDataPath)
        const endpoint = metadata!.transports[0]!.endpoint

        // The ask sub-cap must not narrow the budget for the reserved class.
        for (let i = 0; i < 4; i++) {
          waits.push(
            openFramedSession(endpoint, {
              id: `req_wait_${i}`,
              authToken: metadata!.authToken,
              method: 'orchestration.check',
              params: { terminal: `term_${i}`, wait: true, timeoutMs: 10_000 }
            })
          )
        }
        await waitFor(() => server['activeLongPolls'] === 4)
        expect(server['activeAskLongPolls']).toBe(0)

        const overflow = await sendRequest(endpoint, {
          id: 'req_overflow',
          authToken: metadata!.authToken,
          method: 'orchestration.check',
          params: { terminal: 'term_overflow', wait: true, timeoutMs: 5_000 }
        })
        expect(overflow).toMatchObject({ ok: false, error: { code: 'runtime_busy' } })
      } finally {
        for (const wait of waits) {
          wait.socket.destroy()
        }
        await Promise.all(waits.map((wait) => wait.done))
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
      // Unexpected non-envelope throws still need a terminal error frame and dispatch cleanup; otherwise clients hang until idle timeout.
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
