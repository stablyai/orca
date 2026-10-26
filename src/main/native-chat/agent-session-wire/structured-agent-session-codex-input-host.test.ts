import './structured-agent-session-codex-input-admission.spec'
import {
  continuingStructuredAgentSessionInput,
  finalizingStructuredAgentSessionInput,
  structuredAgentSessionHandingOver
} from './structured-agent-session-handing-over'
import { measureCodexInputWork } from './structured-agent-session-codex-input-perf-test-support'
import { registerCodexInputFinalization } from './structured-agent-session-codex-input-finalization.spec'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { CodexAppServerRequestError } from '../../codex/app-server/codex-app-server-request-error'
import { codexStructuredPermissionPolicy } from '../../codex/codex-structured-permission-policy'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { agentSessionSendSubmission as submission } from '../../../shared/agent-session-wire'
import { AGENT_JOURNAL_THREAD_SCOPE as turnScope } from '../../../shared/agent-session-journal-types'

import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { journalDatabasePath } from '../agent-session-journal/journal-host-database'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { CodexAppServerTimeoutError } from '../../codex/codex-app-server-session'
import {
  THREAD_ID as THREAD,
  adapterFor,
  fakeCodex
} from '../../codex/codex-structured-session-adapter-fixture'
import { codexTurnLifecycleFake } from '../../codex/codex-turn-lifecycle-fake'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { createRestTestRig } from './structured-agent-session-rest-test-rig'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'

const CALLER = { callerKey: 'client-1' }

const platform = process.platform
let retained = false
const config = {
  config: {
    personality: 'friendly',
    service_tier: 'default',
    sandbox_workspace_write: {
      writable_roots: ['/extra'],
      network_access: true,
      exclude_tmpdir_env_var: true,
      exclude_slash_tmp: true
    }
  }
}
const sandbox = {
  type: 'workspaceWrite',
  writableRoots: ['/extra'],
  networkAccess: true,
  excludeTmpdirEnvVar: true,
  excludeSlashTmp: true
}
let events: AgentSessionSubscribeEvent[]
let root: string
let host: StructuredAgentSessionHost
let turns: ReturnType<typeof codexTurnLifecycleFake>
let codex: ReturnType<typeof fakeCodex>
let notify: (method: string, params: unknown) => void
let launch: { resumeThreadId?: string | null }
let adapter: CodexStructuredSessionAdapter

beforeEach(async () => {
  events = []
  retained = false
  codex = fakeCodex({
    'config/read': () => config,
    'thread/goal/get': () => ({ goal: null }),
    'configRequirements/read': () => ({ requirements: null })
  })
  codex.routes['thread/start'] = codex.routes['thread/resume'] = (params) => ({
    thread: { id: THREAD },
    model: 'gpt-live',
    reasoningEffort: 'medium',
    sandbox:
      params?.sandbox === 'danger-full-access'
        ? { type: 'dangerFullAccess' }
        : params?.sandbox === 'read-only'
          ? { type: 'readOnly' }
          : sandbox
  })
  notify = (method, params) => codex.connections.at(-1)?.handlers.onNotification?.(method, params)
  turns = codexTurnLifecycleFake(THREAD, () => notify)
  Object.assign(codex.routes, turns.routes)
  codex.routes['turn/interrupt'] = () => {
    const turnId = turns.turnId
    setTimeout(
      () =>
        notify('turn/completed', { threadId: THREAD, turn: { id: turnId, status: 'interrupted' } }),
      4
    )
    return {}
  }
  launch = {}
  adapter = adapterFor(codex, launch, [], {
    resolveLaunch: async ({ permissionMode, identity }) => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: null,
      resumeThreadId:
        launch.resumeThreadId ??
        store.getRecord(identity.sessionId)?.providerHandleChain.at(-1)?.handle.nativeId ??
        null,
      ...(permissionMode === 'own'
        ? {}
        : { permissionPolicy: codexStructuredPermissionPolicy(permissionMode ?? 'ask') })
    }),
    onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
    onEvent: (event) => {
      if (event.type === 'options-reported' || (event.type === 'ended' && 'cause' in event)) {
        void host.handleAdapterEvent(event)
      }
    }
  })
  const rig = await createRestTestRig({
    agents: claudeAndCodexDeclared(),
    logger: recordingStructuredAgentSessionLogger().logger,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    mintSpawnToken: () => 'spawn-1',
    hasOpenDispatch: () => retained,
    probeOwner: undefined,
    statusSink: undefined,
    idleSweep: undefined
  })
  root = rig.root
  host = rig.host
  const store = rig.store
  expect(
    await host.attach(
      CALLER,
      hostTestAttachParams(null, { options: { permissionMode: 'full-access' } })
    )
  ).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(host['sessions'].get(SESSION)?.child?.phase).toBe('ready'))
  await host.subscribe({
    id: 'stop-note-live',
    sessionId: SESSION,
    emit: (event) => events.push(event)
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  closeTestJournalHostDatabase(root)
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  await rm(root, { recursive: true, force: true })
})

function stop(turnId?: string) {
  const fields = turnId === undefined ? {} : { turnId }
  return host.cancel(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.cancel',
        sessionId: SESSION,
        fields
      })
    },
    ...fields
  })
}

function envelope(method: string, fields: Record<string, unknown>) {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: null,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}
async function pick(value: string) {
  const fields = { key: 'permissionMode', value }
  expect(
    await host.setOption(CALLER, {
      envelope: envelope('agentSession.setOption', fields),
      ...fields
    })
  ).toMatchObject({ ok: true })
}
async function permissionSend(text: string, options?: Record<string, string>) {
  const fields = { body: hostTestMessage(text), ...(options ? { options } : {}) }
  const result = await host.send(CALLER, {
    envelope: envelope('agentSession.send', fields),
    userSend: true,
    ...fields
  })
  if (!result.ok) {
    throw new Error(JSON.stringify(result.refusal))
  }
  return result.value.clientMessageId
}
const row = async (id: string) =>
  (await host.journalSnapshot(SESSION)).submissions.find((s) => s.clientMessageId === id)
const starts = () =>
  codex.connections.flatMap((c) => c.calls.filter((r) => r.method === 'turn/start'))
async function began(id: string) {
  await vi.waitFor(() =>
    expect(starts().some((r) => r.params?.clientUserMessageId === id)).toBe(true)
  )
  turns.start()
  turns.echo(id)
  await vi.waitFor(async () => expect(await row(id)).toMatchObject({ dispatchState: 'accepted' }))
}

it('keeps only the original pre-send result when a ready child exits during Auto preparation', async () => {
  await pick('ask')
  await began(await permissionSend('completed warm turn'))
  turns.end('completed')
  await host.flushStreamedEvents(SESSION)
  const { sessions } = host.collaboratorsForTests()
  const journal = sessions.get(SESSION)!.journal
  const warm = journal.snapshot().items.find((item) => item.body.kind === 'turn')!
  expect(warm.body).toMatchObject({ state: 'completed', outcome: 'success' })
  const child = sessions.get(SESSION)!.child!
  expect(child.phase).toBe('ready')
  const preparation = Promise.withResolvers<unknown>()
  const read = vi.fn(() => preparation.promise)
  codex.routes['config/read'] = read
  await pick('auto')
  const id = await permissionSend('preserve this unsent original')
  const waiting = host.waitForSendSettlement(SESSION, id)
  try {
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    expect(adapter.heldSends(SESSION)).toContain(id)
    expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(true)
    expect(journal.submission(id)).toMatchObject({ dispatchState: 'pending', fence: child.fence })
    expect(starts()).toHaveLength(1)
    codex.connections[0]!.handlers.onExit?.(new Error('ready Codex exited during preparation'), {
      expected: false
    })
    await codexInputFinalizationFixture().waitForInputFinalization(journal, id)
    const result = submission((await waiting)?.value)
    expect(result).toMatchObject({
      clientMessageId: id,
      dispatchState: 'rejected',
      rejection: { kind: 'providerExited', neverReachedAgent: true },
      providerItemId: null,
      answeredInTurn: null
    })
    expect(result).toEqual(journal.submission(id))
    expect(journal.itemBody(agentJournalSubmissionKey(id))).toEqual(
      hostTestMessage('preserve this unsent original')
    )
    await vi.waitFor(() => expect(sessions.get(SESSION)?.child).toBeNull())
    await host.flushStreamedEvents(SESSION)
    const snapshot = await host.journalSnapshot(SESSION)
    expect(snapshot.items.find((item) => item.itemId === warm.itemId)).toEqual(warm)
    expect(
      snapshot.items.filter(
        (item) => item.body.kind === 'status' && item.body.failure?.kind === 'providerExited'
      )
    ).toEqual([])
    expect(starts()).toHaveLength(1)
    expect(codex.connections).toHaveLength(1)
  } finally {
    preparation.resolve(config)
    await host.flushAllStreamedEvents()
  }
})

it.each(['config', 'order', 'initial'] as const)(
  'acquires idle late Auto after the %s wait before writing once',
  async (wait) => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const paused = Promise.withResolvers<unknown>()
    const order =
      wait === 'order'
        ? host.collaboratorsForTests().runtimeState.deliveryOrder.reserve(SESSION)
        : null
    if (wait !== 'order') {
      codex.routes['config/read'] = () => paused.promise
    }
    const delivery = host.collaboratorsForTests().runtimeState.deliveryOrder
    const entered = Promise.withResolvers<void>()
    const beforeSend = delivery.beforeSend.bind(delivery)
    vi.spyOn(delivery, 'beforeSend').mockImplementation((...args) => {
      entered.resolve()
      return beforeSend(...args)
    })
    const old = codex.connections[0]!
    if (wait === 'initial') {
      await pick('auto')
    }
    const deps = host.collaboratorsForTests().conversationDelivery.loop['deps']
    const ran = deps.recordRanOptions!
    const recorded = vi.fn()
    vi.spyOn(deps, 'recordRanOptions').mockImplementation((id, fence) => {
      const recorder = ran(id, fence)
      const record: typeof recorder = async (options) => {
        recorded(id, fence, options)
        await recorder(options)
      }
      return Object.assign(record, recorder)
    })
    const id = await permissionSend('keep my words', { personality: 'friendly' })
    if (wait === 'order') {
      await entered.promise
      expect(isQueuedAgentJournalSubmission((await row(id))!)).toBe(true)
      expect(starts()).toHaveLength(0)
    } else {
      await vi.waitFor(() => expect(old.calls.some((r) => r.method === 'config/read')).toBe(true))
    }
    await pick('auto')
    const compiling = Promise.withResolvers<unknown>()
    codex.routes['thread/start'] = codex.routes['thread/resume'] = () => compiling.promise
    paused.resolve(config)
    order?.release()
    await vi.waitFor(() => expect(codex.connections).toHaveLength(2))
    const acquiring = codex.connections[1]!
    const replacement = host['sessions'].get(SESSION)!.child!
    expect(replacement.fence).toBe(host['deps'].store.getRecord(SESSION)!.lease.runtimeFence)
    await vi.waitFor(() =>
      expect(acquiring.calls.some((r) => r.method.startsWith('thread/'))).toBe(true)
    )
    expect(await row(id)).toMatchObject({ dispatchState: 'pending' })
    expect(host.currentWork(SESSION)?.owesSend((await row(id))!)).toBe(true)
    let answered = false
    const settled = host.waitForSendSettlement(SESSION, id).then((value) => {
      answered = true
      return value
    })
    await pick('ask')
    compiling.resolve({
      thread: { id: THREAD },
      model: 'gpt-live',
      reasoningEffort: 'medium',
      sandbox
    })
    await vi.waitFor(() => expect(starts()).toHaveLength(1))
    expect(old.calls.filter((r) => r.method === 'turn/start')).toHaveLength(0)
    expect(acquiring.calls.find((r) => r.method.startsWith('thread/'))?.params).toMatchObject({
      approvalPolicy: 'on-request'
    })
    expect(starts()[0]?.params).toMatchObject({
      clientUserMessageId: id,
      input: [{ type: 'text', text: 'keep my words' }],
      personality: 'friendly',
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'readOnly' }
    })
    expect(answered).toBe(false)
    turns.start()
    turns.echo(id)
    await vi.waitFor(() =>
      expect(host.readStatusSummary(SESSION)?.runtimePermission).toEqual({
        fence: replacement.fence,
        mode: 'ask'
      })
    )
    expect((await host.readOptions(SESSION)).current.reportedPermissionMode).toBe('ask')
    expect(submission((await settled)?.value)).toMatchObject({
      dispatchState: 'accepted',
      fence: replacement.fence
    })
    await vi.waitFor(() =>
      expect(recorded).toHaveBeenCalledWith(
        SESSION,
        replacement.fence,
        expect.objectContaining({ message: { personality: 'friendly' } })
      )
    )
    await vi.waitFor(() =>
      expect(host['deps'].store.getRecord(SESSION)?.options).toMatchObject({
        model: 'gpt-live',
        effort: 'medium'
      })
    )
  }
)

it.each([
  ['ask', 1],
  ['auto', 1],
  ['auto-before', 1],
  ['empty', 1],
  ['auto', 10],
  ['auto', 100]
] as const)(
  'refreshes stopped words after refused steering with %s and %i stopped messages, including replacement',
  async (mode, population) => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const running = await permissionSend('running')
    await began(running)
    const stoppedIds = Array.from({ length: population }, (_, index) =>
      index === 0 ? 'stopped-words' : `stopped-words-${index}`
    )
    for (const [index, stopped] of stoppedIds.entries()) {
      await journal.appendSubmission({
        clientMessageId: stopped,
        payloadFingerprint: 'stopped',
        body: hostTestMessage(index === 0 ? 'words that were not delivered' : stopped),
        fence: 1,
        source: { kind: 'user' },
        origin: 'client',
        handoverRecorded: true
      })
      if (index > 0) {
        await journal.resolveDispatch({
          clientMessageId: stopped,
          state: 'pending',
          fence: 1,
          turnScope: { kind: 'thread' },
          carries: [stoppedIds[index - 1]!]
        })
      }
      await journal.resolveDispatch({
        clientMessageId: stopped,
        state: 'rejected',
        fence: 1,
        ...agentSessionFailureWords(
          agentSessionFailureFact('cancelled', { neverReachedAgent: true }),
          { surface: 'rejection' }
        )
      })
    }
    const stopped = stoppedIds[0]!
    const refusal = Promise.withResolvers<unknown>()
    codex.routes['turn/steer'] = () => refusal.promise
    await host.flushStreamedEvents(SESSION)
    const measured =
      population > 1 ? measureCodexInputWork(host, events, 'history', population) : undefined
    let waiting: ReturnType<typeof host.waitForSendSettlement> | undefined
    try {
      if (mode === 'auto-before') {
        await pick('auto')
      }
      const id = await permissionSend('follow up')
      if (measured) {
        waiting = host.waitForSendSettlement(SESSION, id)
        void waiting.catch(() => {})
      }
      await vi.waitFor(() =>
        expect(codex.connections[0]?.calls.some((r) => r.method === 'turn/steer')).toBe(true)
      )
      if (mode !== 'auto-before') {
        await pick(mode === 'empty' ? 'ask' : mode)
      }
      if (mode === 'empty') {
        await journal.resolveDispatch({
          clientMessageId: id,
          state: 'pending',
          fence: 1,
          turnScope: { kind: 'thread' },
          carries: [stopped]
        })
        await journal.appendSubmission({
          clientMessageId: 'other-carrier',
          payloadFingerprint: 'other-carrier',
          body: hostTestMessage('history delivered elsewhere'),
          fence: 1
        })
        await journal.resolveDispatch({
          clientMessageId: 'other-carrier',
          state: 'pending',
          fence: 1,
          turnScope,
          carries: [stopped]
        })
        await journal.resolveDispatch({
          clientMessageId: 'other-carrier',
          state: 'accepted',
          fence: 1,
          providerIdentity: null
        })
      }
      turns.end('completed')
      await host.flushStreamedEvents(SESSION)
      refusal.reject(
        new CodexAppServerRequestError('turn/steer', -32600, 'no active turn', 'no active turn')
      )
      await vi.waitFor(() => expect(starts()).toHaveLength(2))
      expect(codex.connections).toHaveLength(mode.startsWith('auto') ? 2 : 1)
      expect(starts()[1]?.params).toMatchObject({ clientUserMessageId: id })
      expect(
        JSON.stringify(starts()[1]?.params?.input).includes('words that were not delivered')
      ).toBe(mode !== 'empty')
      expect(journal.stoppedHistoryCarried().get(id)).toEqual(
        mode === 'empty' ? undefined : stoppedIds
      )
      const item = journal
        .snapshot()
        .items.find((item) => item.itemId === agentJournalSubmissionKey(id))
      expect(item?.turnScope).toEqual({ kind: 'thread' })
      expect(journal.itemBody(agentJournalSubmissionKey(id))).toEqual(hostTestMessage('follow up'))
      for (const stoppedId of stoppedIds.slice(1)) {
        expect(JSON.stringify(starts()[1]?.params?.input)).toContain(stoppedId)
      }
      if (waiting) {
        await began(id)
        expect(submission((await waiting)?.value)).toMatchObject({
          clientMessageId: id,
          dispatchState: 'accepted'
        })
        expect(host['clientDelivery']['sendSettlement']['waiters'].has(SESSION)).toBe(false)
      }
    } finally {
      refusal.resolve({})
      host['clientDelivery']['sendSettlement'].closeSession(SESSION)
      await waiting?.catch(() => {})
      await measured?.()
    }
  }
)

it('preserves successful steering and only current retained work can inherit unknown Auto', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  const running = await permissionSend('running')
  await began(running)
  await pick('auto')
  const steer = await permissionSend('steer')
  await vi.waitFor(() =>
    expect(codex.connections[0]?.calls.some((r) => r.method === 'turn/steer')).toBe(true)
  )
  turns.echo(steer)
  await vi.waitFor(() =>
    expect(host.readStatusSummary(SESSION)?.runtimePermission?.mode).toBe('full-access')
  )
  turns.end('completed')
  await host.flushStreamedEvents(SESSION)
  retained = true
  const busy = await permissionSend('work still held elsewhere')
  await vi.waitFor(() => expect(starts()).toHaveLength(2))
  expect(starts()[1]?.params).not.toHaveProperty('sandboxPolicy')
  expect(codex.connections).toHaveLength(1)
  await began(busy)
  await vi.waitFor(() =>
    expect(host.readStatusSummary(SESSION)?.runtimePermission?.mode).toBe('full-access')
  )
  expect((await host.readOptions(SESSION)).current.reportedPermissionMode).toBe('full-access')
  turns.end('completed')
  await host.flushStreamedEvents(SESSION)
  retained = false
  const idle = await permissionSend('now idle')
  await vi.waitFor(() => expect(starts()).toHaveLength(3))
  expect(codex.connections).toHaveLength(2)
  expect(starts()[2]?.params).toMatchObject({ clientUserMessageId: idle, sandboxPolicy: sandbox })
})

it.each(['stop', 'local-abort'] as const)(
  'keeps an actual sent envelope when %s precedes its Promise delivery and the reply is lost',
  async (cancellation) => {
    const collaborators = host.collaboratorsForTests()
    const session = collaborators.sessions.get(SESSION)!
    const journal = session.journal
    const hostChild = session.child!
    const provider = adapter['sessions'].get(SESSION)!
    const translator = provider.translator
    Object.defineProperty(provider.connection, 'closeResult', {
      get: () => (provider.connection.closed ? { root: 'exited', tree: 'exited' } : undefined)
    })
    const echoed = vi.spyOn(provider.dispatchEchoes, 'settle')
    const persisted = vi.spyOn(journal, 'resolveDispatch')
    const accepted = vi.spyOn(journal, 'acceptLate')
    const settledLate = vi.spyOn(host, 'settleLateDispatch')
    const deps = collaborators.conversationDelivery.loop['deps']
    const ordered = deps.serialize
    const lost = Promise.withResolvers<unknown>()
    const responseObserved = lost.promise.catch(() => {})
    const replyLost = new CodexAppServerTimeoutError('reply lost after the write')
    const entered = Promise.withResolvers<void>()
    const delivery = Promise.withResolvers<void>()
    const frameDelivery = Promise.withResolvers<void>()
    const forwarded: Promise<unknown>[] = []
    codex.routes['turn/start'] = () => lost.promise
    let stopping: Promise<unknown> | undefined
    let frameEnded = false
    let delivered = false
    const dispatch = adapter.dispatch.bind(adapter)
    let restoreSerialize: (() => void) | undefined
    const dispatched = vi.spyOn(adapter, 'dispatch').mockImplementation(async (input) => {
      const serialized = vi.spyOn(deps, 'serialize').mockImplementation((sessionId, task) => {
        const invoked = ordered(sessionId, task)
        const resultDelivery = invoked.then(async (result) => {
          if (result && typeof result === 'object' && 'kind' in result && result.kind === 'sent') {
            expect(result).toMatchObject({ kind: 'sent', response: expect.any(Promise) })
            expect(starts()[0]?.params?.clientUserMessageId).toBe(input.clientMessageId)
            entered.resolve()
            await delivery.promise
            delivered = true
          }
          return result
        })
        forwarded.push(invoked, resultDelivery)
        return resultDelivery
      })
      restoreSerialize = () => serialized.mockRestore()
      try {
        return await dispatch(input)
      } finally {
        if (cancellation === 'stop') {
          await frameDelivery.promise
        }
        frameEnded = true
      }
    })
    const id = await permissionSend('one actual write')
    const waiting = host.waitForSendSettlement(SESSION, id)
    const waiterObserved = vi.fn()
    const waiterObserver = waiting.then(waiterObserved, waiterObserved)
    try {
      await entered.promise
      expect(starts()).toHaveLength(1)
      expect(await row(id)).toMatchObject({ dispatchState: 'pending' })
      expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(true)
      expect(frameEnded).toBe(false)
      expect(waiterObserved).not.toHaveBeenCalled()
      expect(delivered).toBe(false)
      if (cancellation === 'stop') {
        stopping = stop()
      } else {
        expect(
          collaborators.runtimeState.acquireAborts.abort(SESSION, 'local wait cancelled')
        ).toEqual({ reached: true, handedOver: true })
      }
      await vi.waitFor(() => expect(dispatched.mock.calls[0]?.[0].signal?.aborted).toBe(true))
      expect(delivered).toBe(false)
      expect(frameEnded).toBe(false)
      expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(true)
      delivery.resolve()
      lost.reject(replyLost)
      if (cancellation === 'stop') {
        expect(await stopping).toMatchObject({ ok: true })
        await vi.waitFor(() => expect(session.child).toBeNull())
        expect(session.lastEndedChild).toMatchObject({
          fence: hostChild.fence,
          generation: hostChild.generation,
          cause: 'user-stop',
          rootGone: true
        })
        expect(provider.ended).toBe(true)
        expect(provider.connection.closed).toBe(true)
        expect(turns.turnId).toBeNull()
        expect(frameEnded).toBe(false)
        expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(true)
        expect(submission((await waiting)?.value)).toMatchObject({
          dispatchState: 'rejected',
          rejection: { kind: 'cancelled' },
          recovered: true
        })
        expect(
          (await host.journalSnapshot(SESSION)).items.filter(
            (item) => item.body.kind === 'status' && item.body.text === 'Cancellation requested.'
          )
        ).toHaveLength(1)
      } else {
        expect(submission((await waiting)?.value)).toMatchObject({ dispatchState: 'unknown' })
        expect(session.child).toBe(hostChild)
        expect(session.lastEndedChild).toBeUndefined()
        expect(journal.queuedMessages.userStopInForce()).toBeNull()
        expect(adapter['sessions'].get(SESSION)).toBe(provider)
        expect(provider.connection).toBe(codex.connections[0])
        expect(provider.connection.closed).toBe(false)
        expect(codex.connections[0]?.closeCount).toBe(0)
        expect(provider.ended).toBe(false)
        expect(provider.translator).toBe(translator)
        expect(translator).not.toBeNull()
        turns.routes['turn/start']()
        turns.start()
        turns.echo(id)
        await vi.waitFor(async () =>
          expect(await row(id)).toMatchObject({
            dispatchState: 'accepted',
            providerItemId: `codex:${THREAD}:turn-1:0`
          })
        )
        expect(echoed).toHaveBeenCalledWith(id)
        expect(echoed.mock.results.some((result) => result.value === true)).toBe(true)
        expect(accepted).toHaveBeenCalledTimes(1)
        expect(settledLate).toHaveBeenCalledWith({
          sessionId: SESSION,
          clientMessageId: id,
          providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 0 }
        })
      }
      frameDelivery.resolve()
      await vi.waitFor(() => expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(false))
      expect(structuredAgentSessionHandingOver(journal).has(id)).toBe(false)
      expect(dispatched).toHaveBeenCalledTimes(1)
      expect(starts()).toHaveLength(1)
      expect(codex.connections).toHaveLength(1)
      expect(frameEnded).toBe(true)
      await waiterObserver
      expect(waiterObserved).toHaveBeenCalledTimes(1)
    } finally {
      delivery.resolve()
      frameDelivery.resolve()
      lost.reject(replyLost)
      const frames = await Promise.allSettled(dispatched.mock.results.map((result) => result.value))
      await vi.waitFor(() => expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(false))
      const drains = await Promise.allSettled([
        responseObserved,
        waiterObserver,
        stopping,
        ...forwarded,
        ...settledLate.mock.results.map((result) => result.value),
        ...accepted.mock.results.map((result) => result.value),
        ...persisted.mock.results.map((result) => result.value)
      ])
      await host.flushStreamedEvents(SESSION)
      restoreSerialize?.()
      dispatched.mockRestore()
      settledLate.mockRestore()
      accepted.mockRestore()
      persisted.mockRestore()
      echoed.mockRestore()
      expect(frames).toEqual([{ status: 'rejected', reason: replyLost }])
      expect(drains.filter((result) => result.status === 'rejected')).toEqual([])
    }
  }
)

async function assertInputRecoveredAfterSnapshot(id: string): Promise<void> {
  const journal = host['sessions'].get(SESSION)!.journal
  const snapshotRoot = join(root, 'crash')
  await mkdir(snapshotRoot)
  await openTestJournalHostDatabase(root).db.backup(journalDatabasePath(snapshotRoot))
  const fresh = fakeCodex()
  const restartedAdapter = adapterFor(fresh)
  const restarted = new StructuredAgentSessionHost({
    ...host['deps'],
    adapter: restartedAdapter,
    store: await openTestAgentSessionRecordStore(snapshotRoot),
    journalDatabase: openTestJournalHostDatabase(snapshotRoot),
    probeOwner: async () => ({ outcome: 'pid-absent' })
  })
  try {
    await restarted.restoreReadableSessions()
    const recovered = await restarted.journalSnapshot(SESSION)
    const reopened = restarted.collaboratorsForTests().sessions.get(SESSION)!.journal
    expect(reopened).not.toBe(journal)
    expect(continuingStructuredAgentSessionInput(reopened, id)).toBe(false)
    expect(recovered.submissions.find((s) => s.clientMessageId === id)).toMatchObject({
      dispatchState: 'unknown',
      recovered: true
    })
    expect(fresh.connections).toHaveLength(0)
  } finally {
    await restarted.flushAllStreamedEvents()
    await restartedAdapter.closeAll()
    closeTestJournalHostDatabase(snapshotRoot)
  }
}

export function codexInputFinalizationFixture() {
  return {
    host,
    adapter,
    codex,
    config,
    turns,
    permissionSend,
    began,
    submission,
    stop,
    pick,
    row,
    starts,
    assertInputRecoveredAfterSnapshot,
    conversationFence: () => host['deps'].store.getRecord(SESSION)!.lease.runtimeFence,
    waitForInputFinalization: (journal: AgentSessionJournal, id: string) =>
      vi.waitFor(() => expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(false)),
    measureInputWork: (kind: 'history' | 'close', population: number) =>
      measureCodexInputWork(host, events, kind, population)
  }
}

registerCodexInputFinalization(codexInputFinalizationFixture)
