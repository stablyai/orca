import './rpc/unused-default-rpc-methods.test-fixture'

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { readMetadata } from '../../cli/runtime/metadata'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { formatOrcaSessionAddress } from '../../shared/orca-session-address'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import { findTransport } from '../../shared/runtime-bootstrap'
import { codexTurnLifecycleIdentity } from '../codex/codex-structured-journal-translation-turns'
import { structuredAgentSessionProviderRetryPending } from '../native-chat/agent-session-wire/structured-agent-session-provider-retry'
import { idOf, isRecord, resultOf } from './rpc/orchestration-session-caller-test-fixture'
import { captureStructuredWorkerArchive } from './rpc/methods/orchestration-structured-worker-lifecycle'
import { createLongPollServer } from './runtime-rpc-long-poll-server.test-fixture'
import { operationId, providerFaults } from './structured-chat-coordinator-fake-codex-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  codex,
  coordinatorRunAndTask,
  db,
  host,
  openChat,
  queuedCardTexts,
  root,
  runtime,
  sendUserMessage,
  turnText
} from './structured-chat-coordinator-mail-rig.test-fixture'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from './structured-worker-identity'
import type { OrchestrationDb } from './orchestration/db'
import type { FakeConnection } from './structured-chat-coordinator-fake-codex-fixture'

const WORKER = formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))
const TRANSIENT = 'stream disconnected before completion'
const journal = (sessionId: string) => host.collaboratorsForTests().sessions.get(sessionId)!.journal
const hidden = (chat: FakeConnection) => chat.turns.filter((turn) => turn.text === '[]')

async function fullAccess(sessionId: string): Promise<void> {
  const fields = { key: 'permissionMode', value: 'full-access' }
  expect(
    await host.setOption(
      { callerKey: 'test-surface' },
      {
        ...fields,
        envelope: {
          sessionId,
          clientOperationId: operationId(),
          expectedRuntimeFence: host.deps.store.getRecord(sessionId)!.lease.runtimeFence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.setOption',
            sessionId,
            fields
          })
        }
      }
    )
  ).toMatchObject({ ok: true })
}

async function began(sessionId: string, chat: FakeConnection, index: number): Promise<void> {
  const turn = chat.turns[index]!
  chat.handlers.onNotification?.('turn/started', {
    threadId: chat.threadId,
    turn: { id: turn.turnId, status: 'inProgress' }
  })
  if (turn.text !== '[]') {
    chat.handlers.onNotification?.('item/completed', {
      threadId: chat.threadId,
      turnId: turn.turnId,
      item: {
        type: 'userMessage',
        id: `echo-${turn.clientUserMessageId}`,
        clientId: turn.clientUserMessageId,
        content: []
      }
    })
  }
  await host.flushStreamedEvents(sessionId)
}

async function ended(
  sessionId: string,
  chat: FakeConnection,
  index: number,
  transient?: boolean
): Promise<void> {
  const turnId = chat.turns[index]!.turnId
  const error =
    transient === undefined
      ? undefined
      : {
          message: transient ? TRANSIENT : 'The requested operation is invalid.',
          codexErrorInfo: transient ? 'responseStreamDisconnected' : 'badRequest'
        }
  if (error) {
    chat.handlers.onNotification?.('error', {
      threadId: chat.threadId,
      turnId,
      willRetry: transient,
      error
    })
  }
  chat.handlers.onNotification?.('turn/completed', {
    threadId: chat.threadId,
    turn: { id: turnId, status: error ? 'failed' : 'completed', ...(error ? { error } : {}) }
  })
  await host.flushStreamedEvents(sessionId)
}

async function running(sessionId: string, chat: FakeConnection): Promise<number> {
  const index = chat.turns.length
  expect(await sendUserMessage(sessionId, 'finish the accepted request')).toMatchObject({
    ok: true
  })
  await vi.waitFor(() => expect(chat.turns).toHaveLength(index + 1), WAIT)
  await began(sessionId, chat, index)
  expect(journal(sessionId).submission(chat.turns[index]!.clientUserMessageId)?.dispatchState).toBe(
    'accepted'
  )
  return index
}

function holdHiddenReply(chat: FakeConnection) {
  const release = Promise.withResolvers<void>()
  const request = chat.request.bind(chat)
  let held = false
  chat.request = async (method, params, options) => {
    const reply = await request(method, params, options)
    if (method === 'turn/start' && Array.isArray(params?.input) && params.input.length === 0) {
      held = true
      await release.promise
    }
    return reply
  }
  return { release: () => release.resolve(), held: () => held }
}

export function registerStructuredChatCliRetry(input: {
  program: string
  entry: string
  database: typeof OrchestrationDb
}): void {
  let server: ReturnType<typeof createLongPollServer> | undefined
  let home = ''
  let rpcDirectory = ''

  beforeEach(async () => {
    server = undefined
    home = ''
    rpcDirectory = ''
    expect(db).toBeInstanceOf(input.database)
    rpcDirectory = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'oc-'))
    home = join(root, 'cli-home')
    await mkdir(home)
    server = createLongPollServer({ runtime, userDataPath: rpcDirectory, enableWebSocket: false })
    await server.start()
    const metadata = readMetadata(rpcDirectory)
    expect(metadata.runtimeId).toBe(runtime.getRuntimeId())
    expect(metadata.pid).toBe(process.pid)
    const transport = findTransport(metadata, process.platform === 'win32' ? 'named-pipe' : 'unix')
    expect(transport).not.toBeNull()
    if (process.platform !== 'win32') {
      expect(dirname(transport!.endpoint)).toBe(rpcDirectory)
      expect(Buffer.byteLength(transport!.endpoint, 'utf8')).toBeLessThan(104)
    }
    structuredWorkerIdentities.clear()
  })
  afterEach(async () => {
    vi.useRealTimers()
    try {
      await server?.stop()
      if (rpcDirectory) {
        await rm(rpcDirectory, { recursive: true, force: true })
      }
    } finally {
      structuredWorkerIdentities.clear()
    }
  })

  async function cli(sessionId: string, args: string[]): Promise<Record<string, unknown>> {
    const result = await runProcess({
      program: input.program,
      args: [input.entry, 'orchestration', ...args, '--json', '--full'],
      cwd: home,
      env: {
        HOME: home,
        USERPROFILE: home,
        APPDATA: home,
        LOCALAPPDATA: home,
        XDG_CONFIG_HOME: home,
        XDG_CACHE_HOME: home,
        XDG_DATA_HOME: home,
        XDG_STATE_HOME: home,
        CODEX_HOME: join(home, 'codex'),
        CLAUDE_CONFIG_DIR: join(home, 'claude'),
        ORCA_E2E_HOME_DIR: home,
        ORCA_E2E_USER_DATA_DIR: rpcDirectory,
        ORCA_DISABLE_MACOS_LOGIN_SHELL: '1',
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_USER_DATA_PATH: rpcDirectory,
        ORCA_AGENT_SESSION_ID: sessionId,
        SystemRoot: process.env.SystemRoot,
        ComSpec: process.env.ComSpec,
        PATH: process.platform === 'win32' ? process.env.PATH : '/usr/bin:/bin',
        TEMP: root,
        TMP: root,
        TMPDIR: root
      },
      timeoutMs: 15_000,
      signal: AbortSignal.timeout(15_000)
    })
    expect(result.timedOut).toBe(false)
    expect(result.outputTruncated).toBe(false)
    expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0)
    return resultOf(JSON.parse(result.stdout))
  }

  it.each([false, true])(
    'stores and replays CLI report before delivery, with actual running work=%s',
    async (active) => {
      const chat = await openChat(COORDINATOR)
      await fullAccess(COORDINATOR)
      await openChat(PEER_CHAT)
      const { runId } = await coordinatorRunAndTask()
      const t = await running(COORDINATOR, chat)
      const held = holdHiddenReply(chat)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        if (!active) {
          await ended(COORDINATOR, chat, t, true)
          await vi.waitFor(() => expect(held.held()).toBe(true), WAIT)
          expect(hidden(chat)).toHaveLength(1)
          expect(host.currentWork(COORDINATOR)?.working()).toBe(false)
          expect(host.readStatusSummary(COORDINATOR)?.status).toBe('working')
        }
        const mailbox = `run:${runId}`
        const old = db.insertMessage({
          runId,
          from: WORKER,
          to: mailbox,
          subject: 'old unacknowledged batch'
        })
        const run = db.getRun(runId)!
        const delivery = db.getOrCreateMailboxDelivery({
          runId,
          mailboxHandle: mailbox,
          consumerGeneration: run.consumer_generation
        })!.delivery
        const args = [
          'send',
          '--to',
          mailbox,
          '--subject',
          'retry-boundary report',
          '--body',
          'report body',
          '--type',
          'status'
        ]
        const stored = await cli(PEER_CHAT, args)
        const messageId = idOf(stored.message)
        if (!isRecord(stored.mutation) || typeof stored.mutation.requestId !== 'string') {
          throw new Error('missing durable CLI receipt')
        }
        const requestId = stored.mutation.requestId
        expect(stored.mutation).toMatchObject({ replayed: false })
        expect(
          db.db
            .prepare('SELECT method, state FROM mutation_receipts WHERE request_id = ?')
            .get(requestId)
        ).toMatchObject({ method: 'orchestration.send', state: 'completed' })
        const replay = await cli(PEER_CHAT, [...args, '--retry-request', requestId])
        expect(replay).toMatchObject({
          message: { id: messageId },
          mutation: { replayed: true, requestId }
        })
        expect(
          db.getAllMessages(mailbox).filter((row) => row.subject === 'retry-boundary report')
        ).toHaveLength(1)
        expect(db.getMessageById(messageId)?.delivered_at).toBeNull()
        if (active) {
          expect(host.currentWork(COORDINATOR)?.working()).toBe(true)
          expect(journal(COORDINATOR).submissions()).toHaveLength(1)
          expect(chat.turns).toHaveLength(1)
          expect(chat.steers).toEqual([])
          await ended(COORDINATOR, chat, t)
        } else {
          await vi.waitFor(() => expect(journal(COORDINATOR).submissions()).toHaveLength(2), WAIT)
          const operation = db.getStructuredPointerOperation(mailbox)!
          expect(operation).toBeTruthy()
          expect(
            host.deps.store.readCommandReceipt({ kind: 'global' }, operation.operation_id)
          ).toMatchObject({
            verdict: 'readable',
            receipt: { status: 'accepted', result: { kind: 'journal-row' } }
          })
          expect(journal(COORDINATOR).submission(operation.operation_id)?.dispatchState).toBe(
            'pending'
          )
          expect(structuredAgentSessionProviderRetryPending(journal(COORDINATOR))).toBe(false)
          expect(journal(COORDINATOR).receiptFor(operation.operation_id)).toBeNull()
          expect(await queuedCardTexts()).toEqual([])
          await began(COORDINATOR, chat, 1)
          held.release()
          await new Promise<void>((resolve) => setImmediate(resolve))
          // A write is not delivery: the ordinary send still needs its own real start/echo.
          expect(journal(COORDINATOR).submission(operation.operation_id)?.dispatchState).toBe(
            'pending'
          )
          expect(db.getMessageById(messageId)?.delivered_at).toBeNull()
          await ended(COORDINATOR, chat, 1)
        }
        const next = active ? 1 : 2
        await vi.waitFor(() => expect(chat.turns).toHaveLength(next + 1), WAIT)
        expect(turnText(chat.turns[next]!)).toContain('orchestration message')
        expect(db.getMessageById(messageId)?.delivered_at).toBeNull()
        await began(COORDINATOR, chat, next)
        await vi.waitFor(
          () => expect(db.getMessageById(messageId)?.delivered_at).not.toBeNull(),
          WAIT
        )
        const deliveredAt = db.getMessageById(messageId)!.delivered_at
        expect(journal(COORDINATOR).submissions()).toHaveLength(2)
        await ended(COORDINATOR, chat, next)
        expect(await cli(COORDINATOR, ['check', '--run', runId])).toMatchObject({
          deliveryId: delivery.id,
          messages: [expect.objectContaining({ id: old.id })]
        })
        await cli(PEER_CHAT, [...args, '--retry-request', requestId])
        await ended(COORDINATOR, chat, next)
        expect(db.getMessageById(messageId)?.delivered_at).toBe(deliveredAt)
        expect(db.getMessageById(old.id)?.delivered_at).toBeNull()
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        await vi.advanceTimersByTimeAsync(90_000)
        expect(chat.turns).toHaveLength(next + 1)
        expect(journal(COORDINATOR).submissions()).toHaveLength(2)
      } finally {
        held.release()
      }
    },
    45_000
  )

  it.each([false, true])(
    'injects one CLI task across retry-only versus real active work=%s and reads its exact failure',
    async (active) => {
      await openChat(COORDINATOR)
      const chat = await openChat(PEER_CHAT)
      await fullAccess(PEER_CHAT)
      const { runId, taskId } = await coordinatorRunAndTask()
      const t = await running(PEER_CHAT, chat)
      const held = holdHiddenReply(chat)
      let command: Promise<Record<string, unknown>> | undefined
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        if (!active) {
          await ended(PEER_CHAT, chat, t, true)
          await vi.waitFor(() => expect(held.held()).toBe(true), WAIT)
          expect(host.currentWork(PEER_CHAT)?.working()).toBe(false)
        }
        command = cli(COORDINATOR, ['dispatch', '--task', taskId, '--to', WORKER, '--inject'])
        void command.catch(() => undefined)
        if (!active) {
          await vi.waitFor(() => expect(journal(PEER_CHAT).submissions()).toHaveLength(2), WAIT)
          expect(structuredAgentSessionProviderRetryPending(journal(PEER_CHAT))).toBe(false)
          expect(await queuedCardTexts(PEER_CHAT)).toEqual([])
          await began(PEER_CHAT, chat, 1)
          held.release()
          await ended(PEER_CHAT, chat, 1)
        }
        const result = active ? await command : null
        if (active) {
          expect(result).toMatchObject({ injected: true })
          expect(chat.turns).toHaveLength(1)
          expect(await queuedCardTexts(PEER_CHAT)).toHaveLength(1)
          const dispatchId = idOf(result!.dispatch)
          expect(journal(PEER_CHAT).queuedMessages.list()[0]?.body.from).toMatchObject({
            kind: 'agent',
            orchestration: { message: 'task', runId, taskId, dispatchId }
          })
          await ended(PEER_CHAT, chat, t)
        }
        const next = active ? 1 : 2
        await vi.waitFor(() => expect(chat.turns).toHaveLength(next + 1), WAIT)
        await began(PEER_CHAT, chat, next)
        const accepted = result ?? (await command)
        const dispatchId = idOf(accepted.dispatch)
        expect(accepted).toMatchObject({ injected: true })
        expect(turnText(chat.turns[next]!)).toContain(dispatchId)
        expect(await queuedCardTexts(PEER_CHAT)).toEqual([])
        expect(journal(PEER_CHAT).submissions()).toHaveLength(2)
        const senders = (await host.journalSnapshot(PEER_CHAT)).items.flatMap((item) =>
          item.body.kind === 'message' && item.body.from ? [item.body.from] : []
        )
        expect(senders).toMatchObject([
          {
            kind: 'agent',
            senders: [{ party: { orcaSessionId: COORDINATOR } }],
            orchestration: { message: 'task', runId, taskId, dispatchId }
          }
        ])
        expect(db.getDispatchContextById(dispatchId)).toMatchObject({
          run_id: runId,
          assignee_orca_session_id: PEER_CHAT,
          status: 'dispatched'
        })
        await ended(PEER_CHAT, chat, next, false)
        await vi.waitFor(
          () =>
            expect(
              db.getAllMessages(`run:${runId}`).filter((row) => row.type === 'escalation')
            ).toHaveLength(1),
          WAIT
        )
        const read = () =>
          cli(COORDINATOR, ['check', '--run', runId, '--peek', '--types', 'escalation'])
        const requestId = agentJournalItemKey(
          codexTurnLifecycleIdentity(PEER_CHAT, chat.turns[next]!.turnId)
        )
        const first = await read()
        if (
          !Array.isArray(first.messages) ||
          first.messages.length !== 1 ||
          !isRecord(first.messages[0])
        ) {
          throw new Error('expected exactly one escalation')
        }
        const payload: unknown = JSON.parse(String(first.messages[0].payload))
        expect(payload).toMatchObject({ dispatchId, requestId, sessionId: PEER_CHAT })
        expect(first.messages[0].body).toContain('The task is still assigned')
        await ended(PEER_CHAT, chat, next, false)
        host.publishConversationName(PEER_CHAT)
        expect((await read()).messages).toEqual(first.messages)
        expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
        // An assigned person's chat is context-only; this command must not close it.
        expect(await cli(COORDINATOR, ['worker-stop', '--dispatch', dispatchId])).toMatchObject({
          processAction: 'none'
        })
        expect(host.hasSession(PEER_CHAT)).toBe(true)
        expect(hidden(chat)).toHaveLength(active ? 0 : 1)
      } finally {
        held.release()
        await command?.catch(() => undefined)
      }
    },
    45_000
  )

  it('stops an owned worker in backoff through CLI, releases it and reads its already captured output without restart', async () => {
    const coordinator = await openChat(COORDINATOR)
    const chat = await openChat(PEER_CHAT)
    await fullAccess(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    const identity = structuredWorkerIdentities.register({
      handle: mintStructuredWorkerHandle(),
      sessionId: PEER_CHAT,
      agent: 'codex',
      paneKey: mintStructuredWorkerPaneKey(PEER_CHAT),
      processIncarnation: structuredWorkerProcessIncarnation(PEER_CHAT),
      worktreeId: 'workspace-1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    const started = db.createStartingWorkerDispatch({
      taskId,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 9
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: identity.handle,
      paneKey: identity.paneKey,
      processIncarnation: identity.processIncarnation,
      worktreeId: identity.worktreeId,
      hostScope: JSON.stringify(identity.hostScope),
      terminalOwnership: 'created',
      effects: [],
      setupState: 'not_configured'
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    const t = await running(PEER_CHAT, chat)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await ended(PEER_CHAT, chat, t, true)
    expect(structuredAgentSessionProviderRetryPending(journal(PEER_CHAT))).toBe(true)
    const originalJournal = journal(PEER_CHAT)
    const coordinatorJournal = journal(COORDINATOR)
    const coordinatorLease = host.deps.store.getRecord(COORDINATOR)!.lease
    const workerLease = host.deps.store.getRecord(PEER_CHAT)!.lease
    const resource = db.getWorkerTerminalResourceByOwner(started.dispatch.id)!
    const worker = db.getWorkerDispatch(started.dispatch.id)!
    const dispatch = db.getDispatchContextById(started.dispatch.id)!
    expect(resource).toMatchObject({
      origin_dispatch_id: started.dispatch.id,
      owner_dispatch_id: started.dispatch.id,
      terminal_handle: identity.handle,
      pane_key: identity.paneKey,
      process_incarnation: identity.processIncarnation,
      worktree_id: identity.worktreeId,
      host_scope: JSON.stringify(identity.hostScope),
      ownership_state: 'owned',
      release_state: 'not_requested',
      archive_source: null,
      archive_status: null
    })
    expect(worker).toMatchObject({
      dispatch_id: started.dispatch.id,
      state: 'ready',
      agent_terminal_handle: identity.handle,
      worktree_id: identity.worktreeId
    })
    expect(dispatch).toMatchObject({
      id: started.dispatch.id,
      assignee_handle: identity.handle,
      assignee_pane_key: identity.paneKey,
      process_incarnation: identity.processIncarnation,
      host_scope: JSON.stringify(identity.hostScope)
    })
    const connections = [...codex.connections]
    const providerStarts = providerFaults.starts
    const turnStarts = providerFaults.turnStarts
    function expectNoReplacementOrHiddenWrite(): void {
      expect(codex.connections).toHaveLength(connections.length)
      for (const [index, connection] of connections.entries()) {
        expect(codex.connections[index]).toBe(connection)
        expect(hidden(connection)).toHaveLength(0)
      }
      expect(providerFaults.starts).toBe(providerStarts)
      expect(providerFaults.turnStarts).toBe(turnStarts)
    }
    function expectCoordinatorOwnership(): void {
      expect(host.hasSession(COORDINATOR)).toBe(true)
      expect(journal(COORDINATOR)).toBe(coordinatorJournal)
      expect(coordinator.closed).toBe(false)
      expect(host.deps.store.getRecord(COORDINATOR)?.lease).toMatchObject({
        claimStatus: 'live',
        runtimeFence: coordinatorLease.runtimeFence,
        ownerProcess: coordinatorLease.ownerProcess
      })
    }
    function expectLiveArchiveInput(): void {
      expect(db.getWorkerTerminalResourceByOwner(started.dispatch.id)).toEqual(resource)
      expect(db.getWorkerDispatch(started.dispatch.id)).toEqual(worker)
      expect(db.getDispatchContextById(started.dispatch.id)).toEqual(dispatch)
      expect(structuredWorkerIdentities.get(identity.handle)).toBe(identity)
      expect(structuredWorkerIdentities.getBySessionId(PEER_CHAT)).toBe(identity)
      expect(host.hasSession(PEER_CHAT)).toBe(true)
      expect(journal(PEER_CHAT)).toBe(originalJournal)
      expect(host.deps.store.getRecord(PEER_CHAT)?.lease).toMatchObject({
        sessionId: PEER_CHAT,
        claimStatus: 'live',
        runtimeFence: workerLease.runtimeFence,
        ownerProcess: workerLease.ownerProcess
      })
      expect(chat.closed).toBe(false)
      expect(structuredAgentSessionProviderRetryPending(originalJournal)).toBe(true)
      expectNoReplacementOrHiddenWrite()
      expectCoordinatorOwnership()
    }
    expectLiveArchiveInput()
    expect(db.getWorkerTerminalArchive(started.dispatch.id)).toBeUndefined()
    // API-prepared archive; this does not establish an ordinary ready-worker capture action.
    const archive = await captureStructuredWorkerArchive(identity, 'codex')
    expect(archive.processIncarnation).toBe(identity.processIncarnation)
    expect(archive.messages.length).toBeGreaterThan(0)
    expect(JSON.stringify(archive.messages)).toContain('finish the accepted request')
    db.storeWorkerTerminalArchive({
      dispatchId: started.dispatch.id,
      resourceId: resource.id,
      kind: 'structured_journal',
      content: JSON.stringify(archive)
    })
    const capturedRow = db.getWorkerTerminalArchive(started.dispatch.id)!
    expect(capturedRow).toMatchObject({
      dispatch_id: started.dispatch.id,
      resource_id: resource.id,
      kind: 'structured_journal',
      content: JSON.stringify(archive)
    })
    expect(JSON.parse(capturedRow.content)).toEqual(archive)
    expectLiveArchiveInput()
    const stopped = await cli(COORDINATOR, ['worker-stop', '--dispatch', started.dispatch.id])
    expect(stopped).toMatchObject({ state: 'stopped', processAction: 'closed_agent_terminal' })
    expect(host.hasSession(PEER_CHAT)).toBe(false)
    expect(host.deps.store.getRecord(PEER_CHAT)?.lease.claimStatus).toBe('released')
    expect(db.getWorkerTerminalArchive(started.dispatch.id)).toEqual(capturedRow)
    expect(
      await cli(COORDINATOR, ['worker-release', '--dispatch', started.dispatch.id])
    ).toMatchObject({
      state: 'released',
      archive: null
    })
    expect(db.getWorkerTerminalResourceByOwner(started.dispatch.id)?.release_state).toBe('released')
    expect(db.getWorkerTerminalResourceByOwner(started.dispatch.id)?.id).toBe(resource.id)
    expect(db.getWorkerTerminalArchive(started.dispatch.id)).toEqual(capturedRow)
    const read = await cli(COORDINATOR, ['worker-read', '--dispatch', started.dispatch.id])
    expect(read).toMatchObject({
      dispatchId: started.dispatch.id,
      provider: 'codex',
      source: 'transcript',
      archived: true,
      status: { liveness: 'exited' },
      transcript: { messages: archive.messages, returnedMessageCount: archive.messages.length }
    })
    expect(JSON.stringify(read.transcript)).toContain('finish the accepted request')
    expect(db.getWorkerTerminalArchive(started.dispatch.id)).toEqual(capturedRow)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(hidden(chat)).toHaveLength(0)
    expect(chat.closed).toBe(true)
    expect(db.getWorkerDispatch(started.dispatch.id)?.state).toBe('stopped')
    expect(db.getWorkerTerminalArchive(started.dispatch.id)).toEqual(capturedRow)
    expect(host.hasSession(PEER_CHAT)).toBe(false)
    expect(host.deps.store.getRecord(PEER_CHAT)?.lease.claimStatus).toBe('released')
    expect(db.getWorkerTerminalResourceByOwner(started.dispatch.id)).toMatchObject({
      id: resource.id,
      owner_dispatch_id: started.dispatch.id,
      release_state: 'released'
    })
    expectNoReplacementOrHiddenWrite()
    expectCoordinatorOwnership()
  }, 45_000)
}
