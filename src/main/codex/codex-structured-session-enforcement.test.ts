import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  openCodexAppServerConnection
} from './codex-app-server-connection'
import { CodexAppServerUnsupportedError } from './codex-app-server-session'
import { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'
import {
  CodexStructuredWriteAuthority,
  digestRequest,
  type CodexStructuredWriteAuthorization,
  type CodexStructuredWriteReceipt
} from './codex-structured-write-authority'

const SESSION = 'session-enforced'
const THREAD = 'thread-enforced'
const TURN = 'turn-enforced'
const roots: string[] = []

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
  roots.length = 0
})

function linkedWorktree(): string {
  const fixture = mkdtempSync(join(tmpdir(), 'orca-adapter-enforcement-'))
  roots.push(fixture)
  const root = join(fixture, 'worktree')
  const gitDir = join(fixture, 'repo', '.git', 'worktrees', 'bounded')
  mkdirSync(root, { recursive: true })
  mkdirSync(gitDir, { recursive: true })
  writeFileSync(join(root, '.git'), `gitdir: ${gitDir}\n`)
  writeFileSync(join(gitDir, 'gitdir'), `${join(root, '.git')}\n`)
  return realpathSync(root)
}

type FakeConnection = Omit<CodexAppServerConnection, 'closed'> & {
  closed: boolean
  handlers: CodexAppServerConnectionHandlers
  calls: { method: string; params?: Record<string, unknown> }[]
  replies: { id: number | string; result: unknown }[]
  errors: { id: number | string; code: number; message: string }[]
}

function fakeCodex(): {
  openConnection: typeof openCodexAppServerConnection
  connections: FakeConnection[]
} {
  const connections: FakeConnection[] = []
  const openConnection = (async (_launch, handlers = {}) => {
    const connection: FakeConnection = {
      closed: false,
      handlers,
      calls: [],
      replies: [],
      errors: [],
      pid: 4321,
      request: async (method, params) => {
        connection.calls.push({ method, params })
        if (method === 'thread/start') {
          return { thread: { id: THREAD } }
        }
        if (method === 'turn/start') {
          return { turn: { id: TURN } }
        }
        return {}
      },
      notify: () => {},
      respond: (id, result) => connection.replies.push({ id, result }),
      respondWithError: (id, code, message) => connection.errors.push({ id, code, message }),
      close: async () => {
        connection.closed = true
      }
    }
    connections.push(connection)
    return connection
  }) as typeof openCodexAppServerConnection
  return { openConnection, connections }
}

function identity(): AgentSessionJournalIdentity {
  return {
    sessionId: SESSION,
    workspaceId: 'workspace-1',
    hostId: 'host-1',
    agent: 'codex',
    providerHandle: { kind: 'codex', threadId: THREAD }
  }
}

function authority(receipts: CodexStructuredWriteReceipt[]): CodexStructuredWriteAuthority {
  return new CodexStructuredWriteAuthority({
    authorizeTurn: ({ writableRoot, requestDigest, turnEpoch }) => ({
      requestReceiptId: `trusted:${turnEpoch}:${requestDigest}`,
      writableRoot,
      capabilityHandle: `host-handle:${turnEpoch}`
    }),
    consumeLease: () => {},
    onReceipt: (receipt) => receipts.push(receipt)
  })
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('Codex structured local-writer enforcement', () => {
  it('preserves host request authority through dispatch admission', async () => {
    const root = linkedWorktree()
    const codex = fakeCodex()
    const authorizeTurn = vi.fn(
      (input: Parameters<CodexStructuredWriteAuthorization['authorizeTurn']>[0]) => ({
        requestReceiptId: input.requestAuthority?.requestReceiptId ?? '',
        writableRoot: input.writableRoot,
        capabilityHandle: 'host-handle-1'
      })
    )
    const gate = new CodexStructuredWriteAuthority({
      authorizeTurn,
      consumeLease: () => {},
      onReceipt: () => {}
    })
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: root,
        codexHome: root,
        resumeThreadId: null,
        effectIsolation: 'local-structured-write',
        isolatedHomePath: root
      }),
      openConnection: codex.openConnection,
      readProcessStartTime: async () => 1_700_000_000_000,
      writeAuthority: gate,
      releaseStructuredWriteHome: async () => {}
    })
    await adapter.acquire({ identity: identity(), fence: 7, spawnToken: 'spawn-1' })
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'change source.txt only' }]
    }
    const requestAuthority = {
      effectAuthority: 'local_structured_write' as const,
      requestReceiptId: 'a'.repeat(64)
    }

    await adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'client-1',
      body,
      fence: 7,
      requestAuthority
    })

    expect(authorizeTurn).toHaveBeenCalledWith({
      sessionId: SESSION,
      turnEpoch: 2,
      fence: 7,
      clientMessageId: 'client-1',
      requestDigest: digestRequest(body),
      writableRoot: root,
      requestAuthority
    })
    await adapter.closeAll()
  })

  it('admits one file-change item while declining command, permission, and replay effects', async () => {
    const root = linkedWorktree()
    const receipts: CodexStructuredWriteReceipt[] = []
    const gate = authority(receipts)
    const codex = fakeCodex()
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: root,
        codexHome: root,
        resumeThreadId: null,
        effectIsolation: 'local-structured-write',
        isolatedHomePath: root
      }),
      openConnection: codex.openConnection,
      readProcessStartTime: async () => 1_700_000_000_000,
      writeAuthority: gate,
      releaseStructuredWriteHome: async () => {}
    })
    await adapter.acquire({ identity: identity(), fence: 7, spawnToken: 'spawn-1' })
    await adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'client-1',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'change source.txt only' }]
      },
      fence: 7
    })

    expect(codex.connections[0].calls.at(-1)?.params).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'readOnly', networkAccess: false }
    })
    const notify = codex.connections[0].handlers.onNotification
    const ask = codex.connections[0].handlers.onServerRequest
    notify?.('item/started', {
      threadId: THREAD,
      turnId: TURN,
      item: {
        type: 'fileChange',
        id: 'change-1',
        status: 'inProgress',
        changes: [{ path: 'source.txt', diff: '+after', kind: { type: 'add' } }]
      }
    })
    ask?.({
      id: 1,
      method: 'item/fileChange/requestApproval',
      params: { itemId: 'change-1', threadId: THREAD, turnId: TURN }
    })
    await expect
      .poll(() => codex.connections[0].replies)
      .toContainEqual({ id: 1, result: { decision: 'accept' } })

    writeFileSync(join(root, 'source.txt'), 'after\n')
    notify?.('item/completed', {
      threadId: THREAD,
      turnId: TURN,
      item: {
        type: 'fileChange',
        id: 'change-1',
        status: 'completed',
        changes: [{ path: 'source.txt', diff: '+after', kind: { type: 'add' } }]
      }
    })
    await expect.poll(() => receipts.length).toBe(1)
    expect(receipts[0]).toMatchObject({
      effectDomain: 'local_structured_write',
      worktreeRoot: root,
      toolUseId: 'change-1',
      outcome: 'completed'
    })

    for (const [id, method, result] of [
      [2, 'item/commandExecution/requestApproval', { decision: 'decline' }],
      [3, 'item/permissions/requestApproval', { permissions: {}, scope: 'turn' }]
    ] as const) {
      ask?.({ id, method, params: { itemId: `item-${id}`, threadId: THREAD, turnId: TURN } })
      await nextTask()
      expect(codex.connections[0].replies).toContainEqual({ id, result })
    }

    notify?.('item/started', {
      threadId: THREAD,
      turnId: TURN,
      item: {
        type: 'fileChange',
        id: 'change-2',
        status: 'inProgress',
        changes: [{ path: 'second.txt', diff: '+second', kind: { type: 'add' } }]
      }
    })
    ask?.({
      id: 4,
      method: 'item/fileChange/requestApproval',
      params: { itemId: 'change-2', threadId: THREAD, turnId: TURN }
    })
    await nextTask()
    expect(codex.connections[0].replies).toContainEqual({ id: 4, result: { decision: 'decline' } })

    ask?.({ id: 5, method: 'item/unknownMutatingEffect/requestApproval', params: {} })
    await nextTask()
    expect(codex.connections[0].errors).toContainEqual({
      id: 5,
      code: -32601,
      message: 'structured-writer mode does not permit item/unknownMutatingEffect/requestApproval'
    })
    await adapter.closeAll()
  })

  it('leaves normal sessions unchanged when writer support is installed', async () => {
    const root = linkedWorktree()
    const codex = fakeCodex()
    const gate = authority([])
    const revokePendingTurn = vi.spyOn(gate, 'revokePendingTurn')
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: root,
        codexHome: null,
        resumeThreadId: null
      }),
      openConnection: codex.openConnection,
      writeAuthority: gate,
      releaseStructuredWriteHome: async () => {}
    })

    await expect(
      adapter.acquire({ identity: identity(), fence: 7, spawnToken: 'spawn-1' })
    ).resolves.toBeDefined()
    expect(codex.connections).toHaveLength(1)
    await expect(
      adapter.dispatch({
        sessionId: SESSION,
        clientMessageId: 'client-normal',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'write' }]
        },
        fence: 7,
        requestAuthority: {
          effectAuthority: 'local_structured_write',
          requestReceiptId: 'a'.repeat(64)
        }
      })
    ).resolves.toMatchObject({
      state: 'rejected',
      reason: 'local structured write requires a dedicated writer session'
    })
    await expect(
      adapter.cancelTurn({ sessionId: SESSION, turnId: TURN, fence: 7 })
    ).resolves.toEqual({ cancelled: true })
    expect(revokePendingTurn).not.toHaveBeenCalled()
    await adapter.closeAll()
  })

  it('interrupts the active writer turn before admitting a replacement turn', async () => {
    const root = linkedWorktree()
    const codex = fakeCodex()
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: root,
        codexHome: root,
        resumeThreadId: null,
        effectIsolation: 'local-structured-write',
        isolatedHomePath: root
      }),
      openConnection: codex.openConnection,
      readProcessStartTime: async () => 1_700_000_000_000,
      writeAuthority: authority([]),
      releaseStructuredWriteHome: async () => {}
    })
    await adapter.acquire({ identity: identity(), fence: 7, spawnToken: 'spawn-1' })
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'first write' }]
    }
    await adapter.dispatch({ sessionId: SESSION, clientMessageId: 'client-1', body, fence: 7 })
    const connection = codex.connections[0]
    const request = connection.request
    connection.request = async (method, params, options) => {
      const result = await request(method, params, options)
      if (method === 'turn/interrupt') {
        connection.handlers.onNotification?.('turn/completed', {
          threadId: THREAD,
          turn: { id: TURN, status: 'interrupted' }
        })
      }
      return result
    }
    await adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'client-2',
      body: { ...body, blocks: [{ type: 'text', text: 'stop and do this instead' }] },
      fence: 7
    })

    const turnCalls = codex.connections[0].calls.filter(({ method }) => method.startsWith('turn/'))
    expect(turnCalls.map(({ method }) => method)).toEqual([
      'turn/start',
      'turn/interrupt',
      'turn/start'
    ])
    expect(turnCalls[1]).toMatchObject({
      params: { threadId: THREAD, turnId: TURN }
    })
    await adapter.closeAll()
  })

  it('closes the writer session when the active mutation turn cannot be interrupted', async () => {
    const root = linkedWorktree()
    const codex = fakeCodex()
    const gate = authority([])
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: root,
        codexHome: root,
        resumeThreadId: null,
        effectIsolation: 'local-structured-write',
        isolatedHomePath: root
      }),
      openConnection: codex.openConnection,
      readProcessStartTime: async () => 1_700_000_000_000,
      writeAuthority: gate,
      releaseStructuredWriteHome: async () => {}
    })
    await adapter.acquire({ identity: identity(), fence: 7, spawnToken: 'spawn-1' })
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'first write' }]
    }
    await adapter.dispatch({ sessionId: SESSION, clientMessageId: 'client-1', body, fence: 7 })
    const connection = codex.connections[0]
    const request = connection.request
    connection.request = async (method, params, options) => {
      if (method === 'turn/interrupt') {
        throw new CodexAppServerUnsupportedError('turn/interrupt is unavailable')
      }
      return request(method, params, options)
    }

    await expect(
      adapter.dispatch({
        sessionId: SESSION,
        clientMessageId: 'client-2',
        body: { ...body, blocks: [{ type: 'text', text: 'replace the request' }] },
        fence: 7
      })
    ).resolves.toEqual({
      state: 'rejected',
      reason: 'the previous writer turn could not be stopped; the writer session was closed'
    })
    expect(connection.closed).toBe(true)
    await expect(
      gate.openTurn({ sessionId: SESSION, clientMessageId: 'client-3', body, fence: 7 })
    ).rejects.toThrow('no host-selected writable worktree')
  })

  it('snapshots the exact request before host admission can yield', async () => {
    const root = linkedWorktree()
    const codex = fakeCodex()
    const admission = Promise.withResolvers<void>()
    let admittedDigest = ''
    const gate = new CodexStructuredWriteAuthority({
      authorizeTurn: async (input) => {
        admittedDigest = input.requestDigest
        await admission.promise
        return {
          requestReceiptId: 'request-1',
          writableRoot: input.writableRoot,
          capabilityHandle: 'handle-1'
        }
      },
      consumeLease: () => {},
      onReceipt: () => {}
    })
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: root,
        codexHome: root,
        resumeThreadId: null,
        effectIsolation: 'local-structured-write',
        isolatedHomePath: root
      }),
      openConnection: codex.openConnection,
      readProcessStartTime: async () => 1_700_000_000_000,
      writeAuthority: gate,
      releaseStructuredWriteHome: async () => {}
    })
    await adapter.acquire({ identity: identity(), fence: 7, spawnToken: 'spawn-1' })
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'original request' }]
    }
    const dispatch = adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'client-1',
      body,
      fence: 7
    })
    await expect.poll(() => admittedDigest).not.toBe('')
    body.blocks[0].text = 'mutated after admission began'
    admission.resolve()
    await dispatch

    expect(admittedDigest).toBe(
      digestRequest({
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'original request' }]
      })
    )
    expect(codex.connections[0].calls.at(-1)).toMatchObject({
      method: 'turn/start',
      params: { input: [{ type: 'text', text: 'original request' }] }
    })
    await adapter.closeAll()
  })

  it('rejects non-text input without dispatch and invalidates the previous mutation lease', async () => {
    const root = linkedWorktree()
    const codex = fakeCodex()
    const gate = authority([])
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: root,
        codexHome: root,
        resumeThreadId: null,
        effectIsolation: 'local-structured-write',
        isolatedHomePath: root
      }),
      openConnection: codex.openConnection,
      readProcessStartTime: async () => 1_700_000_000_000,
      writeAuthority: gate,
      releaseStructuredWriteHome: async () => {}
    })
    await adapter.acquire({ identity: identity(), fence: 7, spawnToken: 'spawn-1' })
    await adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'client-1',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'first request' }]
      },
      fence: 7
    })
    const rejected = await adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'client-2',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'image-ref', path: '/tmp/untrusted.png' }]
      },
      fence: 8
    })
    expect(rejected).toEqual({
      state: 'rejected',
      reason: 'structured writer accepts only text request blocks'
    })
    expect(codex.connections[0].calls.filter(({ method }) => method === 'turn/start')).toHaveLength(
      1
    )

    const notify = codex.connections[0].handlers.onNotification
    const ask = codex.connections[0].handlers.onServerRequest
    notify?.('item/started', {
      threadId: THREAD,
      turnId: TURN,
      item: {
        type: 'fileChange',
        id: 'stale-change',
        status: 'inProgress',
        changes: [{ path: 'stale.txt', diff: '+stale', kind: { type: 'add' } }]
      }
    })
    ask?.({
      id: 9,
      method: 'item/fileChange/requestApproval',
      params: { itemId: 'stale-change', threadId: THREAD, turnId: TURN }
    })
    await expect
      .poll(() => codex.connections[0].replies)
      .toContainEqual({ id: 9, result: { decision: 'decline' } })
    await adapter.closeAll()
  })

  it('releases the isolated home and revokes authority after a pre-publish failure', async () => {
    const root = linkedWorktree()
    const gate = authority([])
    const release = vi.fn(async () => {})
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: root,
        codexHome: '/isolated/session-enforced',
        isolatedHomePath: '/isolated/session-enforced',
        resumeThreadId: null,
        effectIsolation: 'local-structured-write'
      }),
      openConnection: async () => {
        throw new Error('spawn failed')
      },
      writeAuthority: gate,
      releaseStructuredWriteHome: release
    })

    await expect(
      adapter.acquire({ identity: identity(), fence: 7, spawnToken: 'spawn-1' })
    ).rejects.toThrow('spawn failed')
    expect(release).toHaveBeenCalledWith(SESSION, '/isolated/session-enforced')
    await expect(
      gate.openTurn({
        sessionId: SESSION,
        clientMessageId: 'must-not-open',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'write' }] },
        fence: 7
      })
    ).rejects.toThrow('no host-selected writable worktree')
  })

  it('reaps the child and isolated home even when an ended observer throws', async () => {
    const root = linkedWorktree()
    const codex = fakeCodex()
    const release = vi.fn(async () => {})
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: root,
        codexHome: '/isolated/session-enforced',
        isolatedHomePath: '/isolated/session-enforced',
        resumeThreadId: null,
        effectIsolation: 'local-structured-write'
      }),
      openConnection: codex.openConnection,
      readProcessStartTime: async () => 1_700_000_000_000,
      writeAuthority: authority([]),
      releaseStructuredWriteHome: release,
      onEvent: (event) => {
        if (event.type === 'ended') {
          throw new Error('observer failed')
        }
      }
    })
    await adapter.acquire({ identity: identity(), fence: 7, spawnToken: 'spawn-1' })

    await expect(adapter.closeAll()).rejects.toThrow('observer failed')
    expect(codex.connections[0].closed).toBe(true)
    expect(release).toHaveBeenCalledWith(SESSION, '/isolated/session-enforced')
  })
})
