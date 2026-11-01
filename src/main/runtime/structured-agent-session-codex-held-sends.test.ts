import { createHash } from 'node:crypto'
import { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { replayJournal } from '../native-chat/agent-session-journal/journal-open'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import {
  spawnCodexAppServerConnection,
  openCodexAppServerConnection
} from '../codex/codex-app-server-connection'
import type * as Identity from '../codex/codex-structured-owner-identity'
import type { terminateProviderProcessTree } from '../provider-process/provider-process-teardown'
// Exercise shipped host/journal/adapter with fake Codex: Working follows provider-held sends, including completion without delivery rows; subscribers read real frames.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers
} from '../codex/app-server/codex-app-server-connection-types'
import { codexTurnLifecycleFake } from '../codex/codex-turn-lifecycle-fake'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentJournalSubmission } from '../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../shared/agent-session-wire'
import { hasUnansweredStructuredAgentSessionDispatch } from '../../shared/structured-agent-session-unanswered-dispatch'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { scriptedCodexTransport } from './scripted-codex-transport.test-fixture'

const transportFault = vi.hoisted(() => ({
  terminate: vi.fn<typeof terminateProviderProcessTree>(async () => ({
    tree: null,
    killDelivered: true
  })),
  read: null as null | { entered: () => void; wait: Promise<void> }
}))
vi.mock('../provider-process/provider-process-teardown', async (original) => ({
  ...(await original<object>()),
  terminateProviderProcessTree: transportFault.terminate
}))
vi.mock('../codex/codex-structured-owner-identity', async (original) => {
  const actual = await original<typeof Identity>()
  return {
    ...actual,
    codexSpawnedProcessIdentity: (
      ...args: Parameters<typeof actual.codexSpawnedProcessIdentity>
    ) => {
      const identity = actual.codexSpawnedProcessIdentity(...args)
      return {
        ...identity,
        read: async (pid: number | undefined) => {
          const held = transportFault.read
          if (held) {
            held.entered()
            await held.wait
          }
          return identity.read(pid)
        }
      }
    }
  }
})
const ownedChildren: ReturnType<typeof createFakePipedChild>[] = []

const CALLER = { callerKey: 'codex-held-sends-test' }

let root: string
let host: StructuredAgentSessionHost
let fence: number
let handlers: CodexAppServerConnectionHandlers | undefined
let answers: number
let turns: ReturnType<typeof codexTurnLifecycleFake>
let operations = 0
const events: AgentSessionSubscribeEvent[] = []

const operationId = (): string => `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const fields = { body }
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: operationId(),
      expectedRuntimeFence: fence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields
      })
    },
    body
  })
  if (!sent.ok) {
    throw new Error(JSON.stringify(sent.refusal))
  }
  return sent.value.clientMessageId
}

/** The send as the newest frame that carried it told the subscriber. */
function lastPublished(clientMessageId: string): AgentJournalSubmission | undefined {
  for (const event of events.toReversed()) {
    const submissions =
      event.type === 'batch'
        ? event.batch.submissions
        : event.type === 'snapshot' || event.type === 'reset'
          ? event.page.submissions
          : []
    const found = submissions.find((entry) => entry.clientMessageId === clientMessageId)
    if (found) {
      return found
    }
  }
  return undefined
}

async function rawSubmission(clientMessageId: string): Promise<AgentJournalSubmission> {
  await host.flushStreamedEvents(SESSION)
  const snapshot = await host.journalSnapshot(SESSION)
  const found = snapshot.submissions.find((entry) => entry.clientMessageId === clientMessageId)
  if (!found) {
    throw new Error(`no submission ${clientMessageId}`)
  }
  return found
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-held-sends-'))
  answers = 0
  events.length = 0
  turns = codexTurnLifecycleFake(
    THREAD,
    () => (method, params) => handlers?.onNotification?.(method, params)
  )
  const openConnection: typeof openCodexAppServerConnection = async (
    _launch,
    connectionHandlers = {}
  ) => {
    handlers = connectionHandlers
    const connection: CodexAppServerConnection = {
      pid: 4321,
      closed: false,
      request: async (method, params) => {
        if (method === 'thread/start' || method === 'thread/resume') {
          return { thread: { id: THREAD } }
        }
        if (method === 'turn/start') {
          answers += 1
          return turns.routes['turn/start']()
        }
        if (method === 'turn/steer') {
          return turns.routes['turn/steer'](params)
        }
        return {}
      },
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => true,
      closeOutcome: async () => ({
        accepted: true,
        physical: { root: 'exited', tree: 'exited' },
        processless: false,
        receive: { state: 'complete' }
      })
    }
    return connection
  }
  host = await ensureStructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root,
    resolveLaunchArgs: () => [],
    resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
    resolveCodexCommand: () => ({ command: 'codex', prefixArgs: [] }),
    resolveEnvironment: async () => ({ PATH: process.env.PATH }),
    ...scriptedCodexTransport(openConnection)
  })
  const attachParams = hostTestAttachParams(null, { providerHandle: undefined })
  attachParams.envelope.clientOperationId = operationId()
  const attached = await host.attach(CALLER, attachParams)
  if (!attached.ok) {
    throw new Error(JSON.stringify(attached.refusal))
  }
  fence = attached.value.fence
  await host.subscribe({
    id: 'old-client',
    sessionId: SESSION,
    emit: (event) => events.push(event)
  })
})

afterEach(async () => {
  transportFault.read = null
  for (const child of ownedChildren.splice(0)) {
    child.emit('exit', 0, null)
    child.stdout.end()
  }
  await stopStructuredAgentSessionRuntime()
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

describe('a Codex send whose turn completes without taking it', () => {
  it('allows /compact afterwards without returning or publishing an unconfirmed command', async () => {
    const blocked = await send('a hook blocks this prompt')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    turns.end('completed')
    await vi.waitFor(() => expect(host.currentWork(SESSION)?.working()).toBe(false))
    expect((await rawSubmission(blocked)).dispatchState).toBe('pending')

    const command = 'compact' as const
    const result = await host.conversationCommand(CALLER, {
      command,
      envelope: {
        sessionId: SESSION,
        clientOperationId: operationId(),
        expectedRuntimeFence: fence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.conversationCommand',
          sessionId: SESSION,
          fields: { command }
        })
      }
    })
    expect(result).toMatchObject({ ok: true, value: { command, state: 'completed' } })
    expect(result).not.toHaveProperty('value.error')
    await vi.waitFor(() => expect(host.currentWork(SESSION)?.activeTurnId()).toMatch(/^compact:/))
    const snapshot = await host.journalSnapshot(SESSION)
    const compact = snapshot.submissions.find((entry) => entry.clientMessageId !== blocked)
    if (!compact) {
      throw new Error('missing command submission')
    }
    await vi.waitFor(async () =>
      expect((await rawSubmission(compact.clientMessageId)).dispatchState).toBe('accepted')
    )
    const states = events
      .flatMap((event) => (event.type === 'batch' ? event.batch.submissions : []))
      .filter((entry) => entry.clientMessageId === compact.clientMessageId)
    expect(states.length).toBeGreaterThan(0)
    expect(states.every((entry) => entry.dispatchState !== 'unknown' && !entry.recovered)).toBe(
      true
    )

    handlers?.onNotification?.('turn/started', {
      threadId: THREAD,
      turn: { id: 'turn-compact', status: 'inProgress' }
    })
    handlers?.onNotification?.('item/completed', {
      threadId: THREAD,
      turnId: 'turn-compact',
      item: { type: 'contextCompaction', id: 'compact' }
    })
    handlers?.onNotification?.('turn/completed', {
      threadId: THREAD,
      turn: { id: 'turn-compact', status: 'completed' }
    })
    await vi.waitFor(() => expect(host.currentWork(SESSION)?.working()).toBe(false))
    expect((await host.journalSnapshot(SESSION)).items).toContainEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          kind: 'turn',
          turnId: expect.stringMatching(/^compact:/),
          state: 'completed'
        })
      })
    )
  })

  it('stops being Working with no row written, for the host and a client already following', async () => {
    const blocked = await send('a hook blocks this prompt')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    await vi.waitFor(() => expect(host.currentWork(SESSION)?.working()).toBe(true))

    // Codex completes the turn and never echoes the prompt: a hook refused it.
    turns.end('completed')

    await vi.waitFor(() => expect(host.currentWork(SESSION)?.working()).toBe(false))
    // No delivery row was needed: the journal still has the handover alone.
    expect((await rawSubmission(blocked)).dispatchState).toBe('pending')
    // A client that predates the host's working field reads the send it was sent.
    await vi.waitFor(() =>
      expect(lastPublished(blocked)).toMatchObject({ dispatchState: 'unknown', recovered: true })
    )
    const published = lastPublished(blocked)
    expect(published && hasUnansweredStructuredAgentSessionDispatch([published], fence)).toBe(false)

    const later = await send('second succeeds')
    await vi.waitFor(() => expect(answers).toBe(2))
    turns.start()
    turns.echo(later)
    turns.end('completed')
    await vi.waitFor(async () =>
      expect((await rawSubmission(later)).dispatchState).toBe('accepted')
    )
    handlers?.onExit?.(new Error('codex exited'))
    await vi.waitFor(() =>
      expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    )
    expect(
      (await host.journalSnapshot(SESSION)).items.some(
        (item) => item.body.kind === 'status' && item.body.failure
      )
    ).toBe(false)
  })

  it('keeps a send Working while Codex holds it, and its echo still settles it', async () => {
    const taken = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    // Answered into a turn that has not opened yet: Codex holds it.
    expect(host.currentWork(SESSION)?.working()).toBe(true)
    turns.start()
    turns.echo(taken)
    turns.end('completed')

    await vi.waitFor(async () =>
      expect((await rawSubmission(taken)).dispatchState).toBe('accepted')
    )
    expect(host.currentWork(SESSION)?.working()).toBe(false)
  })
})

describe('a Codex receipt whose first save fails', () => {
  it('saves from the second echo of the same message', async () => {
    const sent = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const accept = vi.spyOn(journal, 'acceptLate').mockRejectedValueOnce(new Error('disk full'))
    const echo = {
      threadId: THREAD,
      turnId: turns.turnId,
      item: { type: 'userMessage', id: 'item-user', clientId: sent, content: [] }
    }

    // Codex echoes a recorded message as its item starts and again as it completes.
    handlers?.onNotification?.('item/started', echo)
    await vi.waitFor(() => expect(accept).toHaveBeenCalledOnce())
    expect((await rawSubmission(sent)).dispatchState).toBe('pending')
    handlers?.onNotification?.('item/completed', echo)

    await vi.waitFor(async () =>
      expect(await rawSubmission(sent)).toMatchObject({
        dispatchState: 'accepted',
        providerItemId: expect.stringMatching(/^codex:/)
      })
    )
    expect(lastPublished(sent)).toMatchObject({ dispatchState: 'accepted' })
  })
})

it.each(['published', 'before-generation'] as const)(
  'settles a %s Codex source fault and completes the successor response without old-root exit',
  async (phase) => {
    await stopStructuredAgentSessionRuntime()
    const readEntered = Promise.withResolvers<void>()
    const readRelease = Promise.withResolvers<void>()
    const sourceError = Object.assign(new Error('read EIO'), { code: 'EIO' })
    const protocols: ReturnType<typeof codexTurnLifecycleFake>[] = []
    const connections: CodexAppServerConnection[] = []
    const openConnection: typeof spawnCodexAppServerConnection = (launch, callbacks = {}) => {
      const child = createFakePipedChild(9_999_990 - ownedChildren.length)
      ownedChildren.push(child)
      if (ownedChildren.length > 1) {
        child.stdin.once('finish', () => {
          child.emit('exit', 0, null)
          child.stdout.end()
        })
      }
      const notify = (method: string, params: unknown) =>
        child.stdout.write(`${JSON.stringify({ method, params })}\n`)
      const protocol = codexTurnLifecycleFake(THREAD, () => notify)
      protocols.push(protocol)
      let pending = ''
      child.stdin.on('data', (bytes) => {
        pending += String(bytes)
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          const frame = JSON.parse(line)
          if (frame.id === undefined) {
            continue
          }
          const result =
            frame.method === 'thread/start' || frame.method === 'thread/resume'
              ? { thread: { id: THREAD }, model: 'scripted-model' }
              : frame.method === 'turn/start'
                ? protocol.routes['turn/start']()
                : frame.method === 'thread/read'
                  ? { thread: { id: THREAD, turns: [] } }
                  : {}
          void Promise.resolve(result).then((result) =>
            child.stdout.write(`${JSON.stringify({ id: frame.id, result })}\n`)
          )
        }
      })
      return spawnCodexAppServerConnection(launch, callbacks, () => child).then((connection) => {
        connections.push(connection)
        return connection
      })
    }
    const logger = { warn: vi.fn(), error: vi.fn() }
    host = await ensureStructuredAgentSessionHost({
      logger,
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => root,
      resolveLaunchArgs: () => [],
      resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
      resolveCodexCommand: () => ({ command: 'codex', prefixArgs: [] }),
      resolveEnvironment: async () => ({ PATH: process.env.PATH }),
      ...scriptedCodexTransport(openConnection)
    })
    const attach = async () => {
      const params = hostTestAttachParams(
        host.deps.store.getRecord(SESSION)?.lease.runtimeFence ?? null,
        { providerHandle: undefined }
      )
      params.envelope.clientOperationId = operationId()
      return host.attach(CALLER, params)
    }
    if (phase === 'before-generation') {
      transportFault.read = { entered: readEntered.resolve, wait: readRelease.promise }
    }
    const attaching = attach().then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    )
    if (phase === 'before-generation') {
      await readEntered.promise
    } else {
      const attached = await attaching
      expect(attached).toHaveProperty('result.ok', true)
      await vi.waitFor(() =>
        expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('ready')
      )
    }
    let originalItemId: string | undefined
    const originalBody = 'Complete original response'
    if (phase === 'published') {
      const attached = await attaching
      if (!('result' in attached) || !attached.result.ok) {
        throw new Error('attach refused')
      }
      fence = attached.result.value.fence
      const original = await send('Original request before the source fault')
      await vi.waitFor(() => expect(protocols[0].turnId).not.toBeNull())
      protocols[0].start()
      protocols[0].echo(original)
      ownedChildren[0].stdout.write(
        `${JSON.stringify({ method: 'item/completed', params: { threadId: THREAD, turnId: protocols[0].turnId, item: { id: 'original-tool', type: 'commandExecution', command: 'printf original', status: 'completed', exitCode: 0, aggregatedOutput: originalBody } } })}\n`
      )
      ownedChildren[0].stdout.write(
        `${JSON.stringify({ method: 'item/completed', params: { threadId: THREAD, turnId: protocols[0].turnId, item: { id: 'original-received-answer', type: 'agentMessage', text: originalBody } } })}\n`
      )
      await vi.waitFor(async () => {
        const snapshot = await host.journalSnapshot(SESSION)
        expect(
          snapshot.submissions.find((row) => row.clientMessageId === original)?.dispatchState
        ).toBe('accepted')
        const item = snapshot.items.find(
          (row) =>
            row.body.kind === 'message' &&
            row.body.role === 'assistant' &&
            JSON.stringify(row.body).includes(originalBody)
        )
        expect(item).toBeDefined()
        originalItemId = item?.itemId
      })
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ownedChildren[0].stdout.emit('error', sourceError)
    readRelease.resolve()
    transportFault.read = null
    await vi.advanceTimersByTimeAsync(60_000)
    if (phase === 'before-generation') {
      const failed = await attaching
      expect(failed).toHaveProperty('result.ok', false)
    }
    expect(connections[0].closed).toBe(true)
    // The public projection still rejects the original input failure.
    await expect(connections[0].close()).rejects.toBe(sourceError)
    const stopped = host.close(SESSION, 'evict')
    await vi.advanceTimersByTimeAsync(60_000)
    await stopped
    expect(host.deps.store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null,
      deathEvidence: { kind: 'kill-delivered' }
    })
    expect(ownedChildren[0].exitCode).toBeNull()
    const retry = attach()
    await vi.advanceTimersByTimeAsync(60_000)
    const next = await retry
    expect(next.ok).toBe(true)
    if (!next.ok) {
      throw new Error(JSON.stringify(next.refusal))
    }
    fence = next.value.fence
    vi.useRealTimers()
    const sent = await send('A healthy successor replies')
    await vi.waitFor(() => expect(protocols[1].turnId).not.toBeNull())
    protocols[1].start()
    protocols[1].echo(sent)
    const body = 'Complete original response'
    ownedChildren[1].stdout.write(
      `${JSON.stringify({ method: 'item/completed', params: { threadId: THREAD, turnId: protocols[1].turnId, item: { id: 'original-answer', type: 'agentMessage', text: body } } })}\n`
    )
    protocols[1].end('completed')
    await vi.waitFor(async () => {
      const snapshot = await host.journalSnapshot(SESSION)
      expect(
        snapshot.submissions.find((entry) => entry.clientMessageId === sent)?.dispatchState
      ).toBe('accepted')
      expect(JSON.stringify(snapshot.items)).toContain(body)
      expect(host.currentWork(SESSION)?.working()).toBe(false)
    })
    expect(ownedChildren).toHaveLength(2)
    const successorFence = fence
    expect(successorFence).toBeGreaterThan(1)
    await host.flushStreamedEvents(SESSION)
    const saved = await host.journalSnapshot(SESSION)
    if (phase === 'published') {
      expect(saved.items.find((item) => item.itemId === originalItemId)?.body).toMatchObject({
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: originalBody }]
      })
    }
    await stopStructuredAgentSessionRuntime()
    const reopened = JournalHostDatabase.open(root)
    try {
      const replay = replayJournal(reopened.db, SESSION)
      expect(replay?.damage).toBeNull()
      expect(replay?.newer).toBeNull()
      const items = [...(replay?.state.items.values() ?? [])]
      if (phase === 'published') {
        expect(items.find((item) => item.itemId === originalItemId)?.body).toMatchObject({
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: originalBody }]
        })
        const tool = items.find(
          (item) => item.body.kind === 'tool-call' && item.body.callId === 'original-tool'
        )
        expect(tool?.body).toMatchObject({
          kind: 'tool-call',
          callId: 'original-tool',
          state: 'completed',
          output: {
            head: originalBody,
            byteLength: 26,
            digest: createHash('sha256').update(originalBody).digest('hex'),
            truncated: false
          }
        })
        expect(tool!.sequence).toBeLessThan(
          items.find((item) => item.itemId === originalItemId)!.sequence
        )
      }
      expect(items.some((item) => JSON.stringify(item.body).includes(body))).toBe(true)
    } finally {
      reopened.close()
    }
  }
)

it.each(['onSpawned', 'handshake'] as const)(
  'retains the original %s failure through accepted direct construction cleanup',
  async (boundary) => {
    const child = createFakePipedChild(9_999_980)
    ownedChildren.push(child)
    const original = Object.assign(new Error('original direct open EIO'), { code: 'EIO' })
    child.stdin.once('data', () => child.stdout.emit('error', original))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const opening = openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      boundary === 'onSpawned'
        ? {
            onSpawned: async () => {
              child.stdout.emit('error', original)
              throw original
            }
          }
        : {},
      () => child
    ).then(
      () => undefined,
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(60_000)
    const report = await opening
    expect(report).toMatchObject({
      name: 'AgentSessionAcquisitionRootExitObservedError',
      deathEvidenceKind: 'kill-delivered'
    })
    if (boundary === 'onSpawned') {
      expect(report).toHaveProperty('cause', original)
    } else {
      expect(report).toHaveProperty('cause', expect.any(AggregateError))
      if (!(report instanceof Error) || !(report.cause instanceof AggregateError)) {
        throw new Error('missing receive causes')
      }
      expect(report.cause.errors).toContain(original)
      expect(report.cause.errors[0]).toBeInstanceOf(Error)
    }
    expect(child.exitCode).toBeNull()
  }
)
