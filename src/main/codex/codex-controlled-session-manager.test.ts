import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess, spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import type { ConversationWakeTurnRequest } from '../runtime/orchestration/conversation-wake-provider'
import {
  CodexControlledSessionManager,
  type CodexControlledSessionLaunch
} from './codex-controlled-session-manager'
import { resolveControlledCodexLaunchAuthority } from './codex-controlled-launch-authority'
import {
  startControlledCodexServer,
  stopControlledCodexServer
} from './codex-controlled-session-launch'

type StubState = {
  status: 'idle' | 'active'
  turns: Record<string, unknown>[]
  turnStarts: number
  rejectNextStart: boolean
  rejectNextRead: boolean
  leaveNextStartAmbiguous: boolean
  servers: Server[]
  sockets: WebSocketServer[]
}

const roots: string[] = []
const managers: CodexControlledSessionManager[] = []

afterEach(async () => {
  for (const manager of managers) {
    await manager.dispose()
  }
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
  managers.length = 0
  roots.length = 0
  vi.restoreAllMocks()
})

describe('CodexControlledSessionManager', () => {
  it('fails closed until every controlled-session flag is enabled', async () => {
    const fixture = createFixture({ launch: false })
    await expect(fixture.manager.launch(fixture.input)).rejects.toThrow(
      'controlled Codex launch is disabled'
    )
    expect(fixture.spawnProcess).not.toHaveBeenCalled()
  })

  it('launches a visible remote resume over a short private Unix socket', async () => {
    const fixture = createFixture()
    const identity = await fixture.manager.launch(fixture.input)

    expect(identity).toMatchObject({
      disposition: 'created',
      identity: { threadId: 'thread-1', terminalPtyId: 'pty-1' }
    })
    expect(fixture.terminalLaunches).toHaveLength(1)
    expect(fixture.terminalLaunches[0]?.command).toContain("'resume' '--remote' 'unix://")
    expect(fixture.terminalLaunches[0]?.command).toContain(
      "'--model' 'gpt-5' '--sandbox' 'workspace-write' '--ask-for-approval' 'never'"
    )
    expect(fixture.terminalLaunches[0]?.env).toEqual({ CODEX_HOME: fixture.input.codexHome })
    expect(fixture.terminalLaunches[0]?.presentation).toBe('focused')
    expect(Buffer.byteLength(fixture.socketPath())).toBeLessThanOrEqual(100)
    expect(statSync(fixture.socketPath()).mode & 0o777).toBe(0o600)
    await expect(fixture.manager.getState(target(fixture.input.conversationId))).resolves.toBe(
      'idle'
    )
  })

  it('uses a plain Codex command for both controller and visible resume', async () => {
    const fixture = createFixture()

    await fixture.manager.launch(fixture.input)

    expect(fixture.spawnProcess).toHaveBeenCalledOnce()
    expect(fixture.spawnProcess.mock.calls[0]?.slice(0, 2)).toEqual([
      'codex',
      ['app-server', '--listen', `unix://${fixture.socketPath()}`]
    ])
    expect(fixture.terminalLaunches[0]?.command).toMatch(/^'codex' 'resume' /)
  })

  it('shares quoted executable and profile prefix args across controller and resume', async () => {
    const fixture = createFixture()
    const authority = resolveControlledCodexLaunchAuthority({
      workspacePath: fixture.input.cwd,
      commandOverride: `"/opt/Codex Preview/codex" --profile "work profile"`,
      prepareCodexHome: () => fixture.input.codexHome,
      getSystemCodexHome: () => '/unused/system-home',
      resolveAccountId: () => fixture.input.accountId
    })
    const { threadId: _threadId, ...newSessionInput } = fixture.input
    const prepared = fixture.manager.prepareNewLaunch(
      {
        ...newSessionInput,
        operationId: 'operation-prefix-args',
        command: authority.commandOverride
      },
      authority.command
    )

    expect(prepared.command).toBe(authority.command)
    await fixture.manager.launchPreparedNew(prepared)

    expect(fixture.spawnProcess).toHaveBeenCalledOnce()
    expect(fixture.spawnProcess.mock.calls[0]?.slice(0, 2)).toEqual([
      '/opt/Codex Preview/codex',
      ['--profile', 'work profile', 'app-server', '--listen', `unix://${fixture.socketPath()}`]
    ])
    expect(fixture.terminalLaunches[0]?.command).toMatch(
      /^'\/opt\/Codex Preview\/codex' '--profile' 'work profile' 'resume' /
    )
  })

  it('rejects an invalid trusted command before launch side effects', async () => {
    const fixture = createFixture()

    await expect(
      fixture.manager.launch({ ...fixture.input, command: `codex --profile "work` })
    ).rejects.toThrow('controlled Codex command is invalid')

    expect(fixture.spawnProcess).not.toHaveBeenCalled()
    expect(fixture.terminalLaunches).toHaveLength(0)
    expect(fixture.processes).toHaveLength(0)
  })

  it('does not retry or fall back after an override spawn fails', async () => {
    const fixture = createFixture()
    const child = new EventEmitter() as ChildProcess & { exitCode: number | null }
    Object.defineProperty(child, 'exitCode', { value: null, writable: true })
    child.kill = (() => {
      child.exitCode = 1
      child.emit('exit', 1, null)
      return true
    }) as ChildProcess['kill']
    fixture.spawnProcess.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit('error', new Error('ENOENT override')))
      return child
    })

    await expect(
      fixture.manager.launch({ ...fixture.input, command: 'codex --profile work' })
    ).rejects.toThrow('ENOENT override')

    expect(fixture.spawnProcess).toHaveBeenCalledOnce()
    expect(fixture.spawnProcess.mock.calls[0]?.slice(0, 2)).toEqual([
      'codex',
      ['--profile', 'work', 'app-server', '--listen', `unix://${fixture.socketPath()}`]
    ])
    expect(fixture.terminalLaunches).toHaveLength(0)
  })

  it('creates a new controlled thread and submits the initial prompt only after readiness', async () => {
    const fixture = createFixture()
    const { threadId: _threadId, ...input } = fixture.input

    const launched = await fixture.manager.launchNew({
      ...input,
      operationId: 'operation-1',
      prompt: 'Coordinate this run.'
    })

    expect(launched).toMatchObject({
      disposition: 'created',
      identity: { threadId: 'thread-1' }
    })
    expect(fixture.readinessChecks.value).toBe(1)
    expect(fixture.stub.turnStarts).toBe(1)
  })

  it('cleans up the visible terminal and controller when readiness times out', async () => {
    const fixture = createFixture({ readinessError: new Error('timeout') })

    await expect(fixture.manager.launch(fixture.input)).rejects.toThrow('timeout')
    expect(fixture.closedTerminals).toHaveLength(1)
    expect(fixture.processes[0]?.exitCode).toBe(0)
  })

  it.each(['initialize', 'thread/start', 'thread/read'] as const)(
    'fails closed when launch authority drifts after %s',
    async (driftAfter) => {
      const fixture = createFixture({ driftAfter })
      const { threadId: _threadId, ...input } = fixture.input

      await expect(
        fixture.manager.launchNew({ ...input, operationId: `operation-${driftAfter}` })
      ).rejects.toThrow('controlled Codex launch account changed')

      expect(fixture.processes[0]?.exitCode).toBe(0)
      if (driftAfter === 'initialize') {
        expect(fixture.terminalLaunches).toHaveLength(0)
      } else if (driftAfter === 'thread/start') {
        expect(fixture.terminalLaunches).toHaveLength(0)
      } else {
        expect(fixture.terminalLaunches).toHaveLength(1)
        expect(fixture.closedTerminals).toHaveLength(1)
      }
    }
  )

  it.each(['initialize', 'thread/resume', 'thread/read'] as const)(
    'fails closed when existing-thread authority drifts after %s',
    async (driftAfter) => {
      const fixture = createFixture({ driftAfter })

      await expect(fixture.manager.launch(fixture.input)).rejects.toThrow(
        'controlled Codex launch account changed'
      )

      expect(fixture.processes[0]?.exitCode).toBe(0)
      if (driftAfter === 'thread/read') {
        expect(fixture.terminalLaunches).toHaveLength(1)
        expect(fixture.closedTerminals).toHaveLength(1)
      } else {
        expect(fixture.terminalLaunches).toHaveLength(0)
      }
    }
  )

  it('keeps a failed terminal cleanup registered for retry', async () => {
    const fixture = createFixture({ closeVisibleTerminalFailures: 1 })
    await fixture.manager.launch(fixture.input)

    await expect(fixture.manager.disposeConversation(fixture.input.conversationId)).rejects.toThrow(
      'terminal close failed'
    )
    expect(fixture.processes[0]?.exitCode).toBeNull()

    await expect(
      fixture.manager.disposeConversation(fixture.input.conversationId)
    ).resolves.toBeUndefined()
    expect(fixture.closedTerminals).toHaveLength(2)
    expect(fixture.processes[0]?.exitCode).toBe(0)
  })

  it('keeps rollback cleanup registered when terminal closure fails', async () => {
    const fixture = createFixture({
      readinessError: new Error('timeout'),
      closeVisibleTerminalFailures: 1
    })

    await expect(fixture.manager.launch(fixture.input)).rejects.toThrow('timeout')
    expect(fixture.processes[0]?.exitCode).toBeNull()

    await expect(
      fixture.manager.disposeConversation(fixture.input.conversationId)
    ).resolves.toBeUndefined()
    expect(fixture.closedTerminals).toHaveLength(2)
    expect(fixture.processes[0]?.exitCode).toBe(0)
  })

  it('preserves the owned socket when SIGKILL does not terminate the controller', async () => {
    vi.useFakeTimers()
    const root = mkdtempSync('/tmp/ocw-stop-test-')
    roots.push(root)
    const socketPath = join(root, 'controller.sock')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    const identity = statSync(socketPath)
    const process = new EventEmitter() as ChildProcess & { exitCode: number | null }
    Object.defineProperty(process, 'exitCode', { value: null, writable: true })
    process.kill = vi.fn(() => true) as ChildProcess['kill']

    const stopping = stopControlledCodexServer(
      { process, socketIdentity: { dev: identity.dev, ino: identity.ino } },
      socketPath
    )
    const stopError = stopping.then(
      () => null,
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(10_000)

    const error = await stopError
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('did not exit after SIGKILL')
    expect(existsSync(socketPath)).toBe(true)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.useRealTimers()
  })

  it('does not unlink or compete with an existing controller socket', async () => {
    const fixture = createFixture()
    writeFileSync(fixture.socketPath(), 'owned')

    await expect(fixture.manager.launch(fixture.input)).rejects.toThrow(
      'controlled Codex socket path is already owned'
    )
    expect(fixture.spawnProcess).not.toHaveBeenCalled()
  })

  it('handles child spawn errors without an unhandled main-process error event', async () => {
    const fixture = createFixture()
    const child = new EventEmitter() as ChildProcess & { exitCode: number | null }
    Object.defineProperty(child, 'exitCode', { value: null, writable: true })
    child.kill = (() => {
      child.exitCode = 1
      child.emit('exit', 1, null)
      return true
    }) as ChildProcess['kill']
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('error', new Error('ENOENT')))
      return child
    }) as unknown as typeof spawn

    await expect(
      startControlledCodexServer(fixture.input, fixture.socketPath(), spawnProcess)
    ).rejects.toThrow('ENOENT')
    expect(child.exitCode).toBe(1)
  })

  it('durably commits before starting and deduplicates the accepted wake', async () => {
    const fixture = createFixture()
    await fixture.manager.launch(fixture.input)
    const commitPrepared = vi.fn(() => true)
    const request = turnRequest(fixture.input.conversationId, commitPrepared)

    const first = await fixture.manager.prepareAndFinalizeTurn(request)
    const acceptedTurnId = first.status === 'finalized' ? first.turnId : null
    const duplicate = await fixture.manager.prepareAndFinalizeTurn({
      ...request,
      acceptedTurnId,
      commitPrepared: vi.fn(() => false)
    })

    expect(commitPrepared).toHaveBeenCalledOnce()
    expect(first).toMatchObject({ status: 'finalized', duplicate: false })
    expect(duplicate).toEqual({ status: 'finalized', turnId: acceptedTurnId, duplicate: true })
    expect(fixture.stub.turnStarts).toBe(1)
  })

  it('creates no provider turn when durable acceptance is rejected', async () => {
    const fixture = createFixture()
    await fixture.manager.launch(fixture.input)

    await expect(
      fixture.manager.prepareAndFinalizeTurn(turnRequest(fixture.input.conversationId, () => false))
    ).resolves.toEqual({ status: 'stale' })
    expect(fixture.stub.turnStarts).toBe(0)
  })

  it('reconciles a start whose error response arrives after Codex records the client message', async () => {
    const fixture = createFixture()
    await fixture.manager.launch(fixture.input)
    fixture.stub.rejectNextStart = true

    await expect(
      fixture.manager.prepareAndFinalizeTurn(turnRequest(fixture.input.conversationId, () => true))
    ).resolves.toMatchObject({ status: 'finalized', duplicate: true })
    expect(fixture.stub.turnStarts).toBe(1)
  })

  it('never retries a durably ambiguous accepted turn when Codex recorded no visible result', async () => {
    const fixture = createFixture()
    await fixture.manager.launch(fixture.input)
    fixture.stub.leaveNextStartAmbiguous = true
    let acceptedTurnId: string | null = null
    const request = turnRequest(fixture.input.conversationId, (turnId) => {
      acceptedTurnId = turnId
      return true
    })

    await expect(fixture.manager.prepareAndFinalizeTurn(request)).rejects.toThrow('ambiguous')
    await expect(
      fixture.manager.prepareAndFinalizeTurn({
        ...request,
        acceptedTurnId,
        commitPrepared: () => false
      })
    ).rejects.toThrow('ambiguous')
    expect(fixture.stub.turnStarts).toBe(1)
  })

  it('queues while active through provider state and emits terminal observation', async () => {
    const fixture = createFixture()
    await fixture.manager.launch(fixture.input)
    fixture.stub.status = 'active'
    const listener = vi.fn()
    fixture.manager.onTurnTerminal(listener)

    await expect(fixture.manager.getState(target(fixture.input.conversationId))).resolves.toBe(
      'active'
    )
    fixture.notify('turn/completed', { threadId: fixture.input.threadId, turn: { id: 'turn-1' } })
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(fixture.input.conversationId))
  })

  it('re-resolves a reminted handle from the stable pane identity', async () => {
    const fixture = createFixture()
    const launched = await fixture.manager.launch(fixture.input)
    fixture.currentHandle.value = 'handle-reminted'

    await expect(fixture.manager.getState(target(fixture.input.conversationId))).resolves.toBe(
      'idle'
    )
    await expect(fixture.manager.launch(fixture.input)).resolves.toMatchObject({
      disposition: 'reused',
      identity: {
        terminalHandle: 'handle-reminted',
        terminalPaneKey: launched.identity.terminalPaneKey
      }
    })
  })

  it.each(['launch', 'launchNew'] as const)(
    'fails closed when authority drifts during reused-session refresh via %s',
    async (method) => {
      const fixture = createFixture()
      await fixture.manager.launch(fixture.input)
      fixture.driftOnNextReadiness.value = true

      if (method === 'launch') {
        await expect(fixture.manager.launch(fixture.input)).rejects.toThrow(
          'controlled Codex launch account changed'
        )
      } else {
        const { threadId: _threadId, ...input } = fixture.input
        await expect(
          fixture.manager.launchNew({ ...input, operationId: 'operation-reused-drift' })
        ).rejects.toThrow('controlled Codex launch account changed')
      }
    }
  )

  it('keeps transient reconciliation reads retryable instead of marking the session missing', async () => {
    const fixture = createFixture()
    await fixture.manager.launch(fixture.input)
    fixture.stub.rejectNextRead = true

    await fixture.manager.reconcile()

    await expect(fixture.manager.getState(target(fixture.input.conversationId))).resolves.toBe(
      'idle'
    )
  })

  it('re-checks kill switches during reconciliation and state inspection', async () => {
    const fixture = createFixture()
    await fixture.manager.launch(fixture.input)
    fixture.flags.killOpen = false

    await fixture.manager.reconcile()

    await expect(fixture.manager.getState(target(fixture.input.conversationId))).resolves.toBe(
      'unknown'
    )
  })

  it.each([
    ['ssh', 'worktree'],
    ['wsl', 'worktree'],
    ['relay', 'worktree'],
    ['local', 'folder']
  ] as const)(
    'rejects unsupported %s/%s placements before spawn',
    async (hostKind, workspaceKind) => {
      const fixture = createFixture()
      await expect(
        fixture.manager.launch({ ...fixture.input, hostKind, workspaceKind })
      ).rejects.toThrow('requires a local worktree host')
      expect(fixture.spawnProcess).not.toHaveBeenCalled()
    }
  )

  it('fails closed when the selected account drifts', async () => {
    const fixture = createFixture()
    await fixture.manager.launch(fixture.input)
    fixture.currentAccount.value = 'account-b'
    await expect(fixture.manager.getState(target(fixture.input.conversationId))).resolves.toBe(
      'unknown'
    )
  })
})

function createFixture(
  options: {
    launch?: boolean
    readinessError?: Error
    driftAfter?: 'initialize' | 'thread/start' | 'thread/resume' | 'thread/read'
    closeVisibleTerminalFailures?: number
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'orca-controlled-codex-test-'))
  const socketRoot = mkdtempSync('/tmp/ocw-test-')
  roots.push(root)
  roots.push(socketRoot)
  const stub: StubState = {
    status: 'idle',
    turns: [],
    turnStarts: 0,
    rejectNextStart: false,
    rejectNextRead: false,
    leaveNextStartAmbiguous: false,
    servers: [],
    sockets: []
  }
  const processes: (ChildProcess & { exitCode: number | null })[] = []
  const spawnProcess = vi.fn((_command: string, args: readonly string[]) => {
    const socketPath = args.at(-1)?.replace(/^unix:\/\//, '') ?? ''
    const process = new EventEmitter() as ChildProcess & { exitCode: number | null }
    Object.defineProperty(process, 'exitCode', { value: null, writable: true })
    processes.push(process)
    const server = createServer()
    const webSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false })
    server.on('upgrade', (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) =>
        webSocketServer.emit('connection', webSocket, request)
      )
    })
    webSocketServer.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as {
          id?: number
          method: string
          params?: Record<string, unknown>
        }
        if (message.id === undefined) {
          return
        }
        if (message.method === 'initialize') {
          send(socket, message.id, {
            userAgent: 'stub/0.145.0',
            codexHome: fixtureInput.codexHome,
            platformFamily: 'unix',
            platformOs: 'macos'
          })
          if (options.driftAfter === 'initialize') {
            currentAccount.value = 'account-b'
          }
        } else if (message.method === 'thread/start' || message.method === 'thread/resume') {
          send(socket, message.id, { thread: thread(stub), cwd: fixtureInput.cwd })
          if (message.method === 'thread/start' && options.driftAfter === 'thread/start') {
            currentAccount.value = 'account-b'
          }
          if (message.method === 'thread/resume' && options.driftAfter === 'thread/resume') {
            currentAccount.value = 'account-b'
          }
        } else if (message.method === 'thread/read') {
          if (stub.rejectNextRead) {
            stub.rejectNextRead = false
            socket.send(JSON.stringify({ id: message.id, error: { message: 'temporary read' } }))
          } else {
            send(socket, message.id, { thread: thread(stub) })
            if (options.driftAfter === 'thread/read') {
              currentAccount.value = 'account-b'
            }
          }
        } else if (message.method === 'turn/start') {
          stub.turnStarts += 1
          if (stub.leaveNextStartAmbiguous) {
            stub.leaveNextStartAmbiguous = false
            socket.send(JSON.stringify({ id: message.id, error: { message: 'ambiguous' } }))
            return
          }
          const turn = {
            id: `turn-${stub.turnStarts}`,
            items: [
              {
                type: 'userMessage',
                clientId: message.params?.clientUserMessageId,
                content: message.params?.input
              }
            ]
          }
          stub.turns.push(turn)
          if (stub.rejectNextStart) {
            stub.rejectNextStart = false
            socket.send(JSON.stringify({ id: message.id, error: { message: 'outcome unknown' } }))
          } else {
            send(socket, message.id, { turn })
          }
        }
      })
    })
    server.listen(socketPath)
    chmodSync(socketRoot, 0o700)
    stub.servers.push(server)
    stub.sockets.push(webSocketServer)
    process.kill = (() => {
      for (const socket of webSocketServer.clients) {
        socket.terminate()
      }
      webSocketServer.close()
      server.close()
      process.exitCode = 0
      process.emit('exit', 0, null)
      return true
    }) as ChildProcess['kill']
    return process
  }) as unknown as typeof spawn & ReturnType<typeof vi.fn>
  const fixtureInput: CodexControlledSessionLaunch = {
    conversationId: 'conversation-1',
    threadId: 'thread-1',
    worktreeSelector: 'id:worktree-1',
    workspaceKind: 'worktree',
    hostKind: 'local',
    cwd: root,
    codexHome: join(root, 'codex-home'),
    accountId: 'account-a',
    command: 'codex',
    model: 'gpt-5',
    sandbox: 'workspace-write',
    approvalPolicy: 'never',
    presentation: 'focused'
  }
  const terminalLaunches: Record<string, unknown>[] = []
  const closedTerminals: Record<string, unknown>[] = []
  const currentAccount = { value: 'account-a' as string | null }
  const currentHandle = { value: 'handle-1' }
  const readinessChecks = { value: 0 }
  const driftOnNextReadiness = { value: false }
  const flags = { killOpen: true }
  const manager = new CodexControlledSessionManager({
    stateRoot: join(root, 'state'),
    socketRoot,
    spawnProcess,
    createVisibleTerminal: async (launch) => {
      terminalLaunches.push(launch)
      return {
        handle: 'handle-1',
        ptyId: 'pty-1',
        tabId: 'tab-1',
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        worktreeId: 'worktree-1',
        surface: 'visible'
      }
    },
    waitForVisibleTerminal: async (terminal) => {
      readinessChecks.value += 1
      if (driftOnNextReadiness.value) {
        driftOnNextReadiness.value = false
        currentAccount.value = 'account-b'
      }
      if (options.readinessError) {
        throw options.readinessError
      }
      return { ...terminal, terminalHandle: currentHandle.value }
    },
    closeVisibleTerminal: async (terminal) => {
      closedTerminals.push(terminal)
      if ((options.closeVisibleTerminalFailures ?? 0) >= closedTerminals.length) {
        throw new Error('terminal close failed')
      }
    },
    resolveCurrentAccountId: () => currentAccount.value,
    isControlledLaunchEnabled: () => options.launch ?? true,
    isProviderEnabled: () => true,
    isWakeEnabled: () => true,
    isKillSwitchOpen: () => flags.killOpen
  })
  managers.push(manager)
  return {
    manager,
    input: fixtureInput,
    stub,
    spawnProcess,
    terminalLaunches,
    currentAccount,
    currentHandle,
    readinessChecks,
    driftOnNextReadiness,
    closedTerminals,
    processes,
    flags,
    socketPath: () => join(socketRoot, '413055e0cb3a7c6d.sock'),
    notify: (method: string, params: Record<string, unknown>) => {
      for (const server of stub.sockets) {
        for (const socket of server.clients) {
          socket.send(JSON.stringify({ method, params }))
        }
      }
    }
  }
}

function thread(stub: StubState): Record<string, unknown> {
  return {
    id: 'thread-1',
    status: { type: stub.status },
    canAcceptDirectInput: true,
    turns: stub.turns
  }
}

function send(socket: { send(value: string): void }, id: number, result: unknown): void {
  socket.send(JSON.stringify({ id, result }))
}

function target(conversationId: string) {
  return { runId: 'run-1', consumerGeneration: 1, conversationId }
}

function turnRequest(
  conversationId: string,
  commitPrepared: (turnId: string) => boolean
): ConversationWakeTurnRequest {
  return {
    ...target(conversationId),
    wakeId: 'wake-1',
    idempotencyKey: 'wake-key-1',
    messageId: 'message-1',
    messageType: 'worker_done',
    taskId: 'task-1',
    dispatchId: 'dispatch-1',
    prompt: 'Check the mailbox.',
    acceptedTurnId: null,
    commitPrepared
  }
}
