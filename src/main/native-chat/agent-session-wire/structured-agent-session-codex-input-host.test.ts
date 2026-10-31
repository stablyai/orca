import { openTestChats } from './structured-agent-session-open-test-chats.test-support'
import { registerCodexSentEnvelope } from './structured-agent-session-codex-sent-envelope.spec'
import { registerRetryCorrelation } from './structured-agent-session-retry-correlation.spec'
import { registerRetryCompletion } from './structured-agent-session-retry-completion.spec'
import { registerCodexProviderRetry } from './structured-agent-session-codex-provider-retry.spec'
import {
  continuingStructuredAgentSessionInput,
  finalizingStructuredAgentSessionInput
} from './structured-agent-session-handing-over'
import { measureCodexInputWork } from './structured-agent-session-codex-input-perf-test-support'
import { registerCodexInputFinalization } from './structured-agent-session-codex-input-finalization.spec'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { CodexAppServerRequestError } from '../../codex/app-server/codex-app-server-request-error'
import { codexStructuredPermissionPolicy } from '../../../shared/codex-permission-policy'
import { journalIdentityFor } from './structured-agent-session-attach'
import { agentSessionSendSubmission as submission } from '../../../shared/agent-session-wire'
import { AGENT_JOURNAL_THREAD_SCOPE as turnScope } from '../../../shared/agent-session-journal-types'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { journalDatabasePath } from '../agent-session-journal/journal-host-database'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  THREAD_ID as THREAD,
  adapterFor,
  fakeCodex
} from '../../codex/codex-structured-session-adapter-fixture'
import { codexTurnLifecycleFake } from '../../codex/codex-turn-lifecycle-fake'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
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
import type { StructuredAgentSessionRequestFailure } from './structured-agent-session-request-failures'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import type { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'

import './structured-agent-session-codex-input-admission.spec'

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
let failures: StructuredAgentSessionRequestFailure[]
let events: AgentSessionSubscribeEvent[]
let root: string
let host: StructuredAgentSessionHost
let turns: ReturnType<typeof codexTurnLifecycleFake>
let codex: ReturnType<typeof fakeCodex>
let notify: (method: string, params: unknown) => void
let launch: { resumeThreadId?: string | null }
let adapter: CodexStructuredSessionAdapter
let ownedRig: Awaited<ReturnType<typeof createRestTestRig>> | undefined
let restartHost: (
  prepare?: (journal: AgentSessionJournal) => Promise<void>
) => Promise<StructuredAgentSessionHost>

let recoveryOperations: Promise<unknown>[] = []
function trackRecoveryOperation(operation: Promise<unknown> | undefined): void {
  if (!operation) {
    return
  }
  recoveryOperations.push(operation)
  void operation.catch(() => undefined)
}
async function drainRecoveryOperations(): Promise<void> {
  const failures: unknown[] = []
  do {
    for (const result of await Promise.allSettled(recoveryOperations.splice(0))) {
      if (result.status === 'rejected') {
        failures.push(result.reason)
      }
    }
  } while (recoveryOperations.length > 0)
  if (failures.length > 0) {
    throw new AggregateError(failures, 'fixture recovery operations failed')
  }
}
beforeEach(async () => {
  ownedRig = undefined
  events = []
  failures = []
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
    onDispatchSettledLate: (settlement) =>
      trackRecoveryOperation(host.settleLateDispatch(settlement)),
    onEvent: (event) => {
      if (event.type === 'options-reported' || (event.type === 'ended' && 'cause' in event)) {
        trackRecoveryOperation(host.handleAdapterEvent(event))
      }
    }
  })
  const rig = await createRestTestRig(
    {
      agents: claudeAndCodexDeclared(),
      logger: recordingStructuredAgentSessionLogger().logger,
      adapter: Object.assign(adapter, { supportsCreate: () => true }),
      mintSpawnToken: () => 'spawn-1',
      hasOpenDispatch: () => retained,
      onRequestFailure: (failure) => failures.push(failure),
      probeOwner: undefined,
      statusSink: undefined,
      idleSweep: undefined
    },
    {
      scoped: true,
      closeAdapter: () => adapter.closeAll(),
      waitForRecovery: drainRecoveryOperations
    }
  )
  ownedRig = rig
  root = rig.root
  host = rig.host
  restartHost = async (prepare) => {
    host = await rig.restart({ probeOwner: async () => ({ outcome: 'pid-absent' }) })
    if (prepare) {
      const record = rig.store.getRecord(SESSION)!
      const saved = await rig.ownProfile(root).openJournal({
        identity: journalIdentityFor(record, hostTestAttachParams(null)),
        database: openTestJournalHostDatabase(root)
      })
      let bodyError: unknown
      let bodyFailed = false
      const cleanupErrors: unknown[] = []
      try {
        await prepare(saved)
      } catch (error) {
        bodyFailed = true
        bodyError = error
      } finally {
        try {
          await saved.close()
        } catch (cleanup) {
          cleanupErrors.push(cleanup)
        }
      }
      if (cleanupErrors.length > 0) {
        const cleanup = cleanupErrors[0]
        if (bodyFailed) {
          throw new AggregateError([bodyError, cleanup], 'saved journal and cleanup failed')
        }
        throw cleanup
      }
      if (bodyFailed) {
        throw bodyError
      }
    }
    await openTestChats(host, [SESSION])
    return host
  }
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
  const current = ownedRig
  ownedRig = undefined
  const cleanupErrors: unknown[] = []
  try {
    vi.useRealTimers()
  } catch (error) {
    cleanupErrors.push(error)
  }
  try {
    if (vi.isMockFunction(adapter?.disposeSession)) {
      adapter.disposeSession.mockRestore()
    }
  } catch (error) {
    cleanupErrors.push(error)
  }
  try {
    await current?.dispose()
  } catch (error) {
    cleanupErrors.push(error)
  }
  for (const restore of [
    () => vi.restoreAllMocks(),
    () => Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  ]) {
    try {
      restore()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0]
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'Codex input fixture cleanup failed')
  }
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
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
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
  let bodyError: unknown
  let bodyFailed = false
  const cleanupErrors: unknown[] = []
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
  } catch (error) {
    bodyFailed = true
    bodyError = error
  } finally {
    try {
      preparation.resolve(config)
      await host.flushAllStreamedEvents()
    } catch (cleanup) {
      cleanupErrors.push(cleanup)
    }
  }
  if (cleanupErrors.length > 0) {
    const cleanup = cleanupErrors[0]
    if (bodyFailed) {
      throw new AggregateError([bodyError, cleanup], 'Auto preparation body and cleanup failed')
    }
    throw cleanup
  }
  if (bodyFailed) {
    throw bodyError
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
    await host.collaboratorsForTests().serialize(SESSION, async () => {
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
    })
    const stopped = stoppedIds[0]!
    const refusal = Promise.withResolvers<unknown>()
    codex.routes['turn/steer'] = () => refusal.promise
    await host.flushStreamedEvents(SESSION)
    const measured =
      population > 1 ? measureCodexInputWork(host, events, 'history', population) : undefined
    let waiting: ReturnType<typeof host.waitForSendSettlement> | undefined
    let bodyError: unknown
    let bodyFailed = false
    const cleanupErrors: unknown[] = []
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
        expect(
          codex.connections[0]?.calls.some(
            (r) => r.method === 'turn/steer' && r.params?.clientUserMessageId === id
          )
        ).toBe(true)
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
    } catch (error) {
      bodyFailed = true
      bodyError = error
    } finally {
      try {
        refusal.resolve({})
        host['clientDelivery']['sendSettlement'].closeSession(SESSION)
        await waiting?.catch(() => {})
        await measured?.()
      } catch (cleanup) {
        cleanupErrors.push(cleanup)
      }
    }
    if (cleanupErrors.length > 0) {
      const cleanup = cleanupErrors[0]
      if (bodyFailed) {
        throw new AggregateError([bodyError, cleanup], 'stopped words body and cleanup failed')
      }
      throw cleanup
    }
    if (bodyFailed) {
      throw bodyError
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

registerCodexSentEnvelope(codexInputFinalizationFixture)

async function assertInputRecoveredAfterSnapshot(id: string): Promise<void> {
  const journal = host['sessions'].get(SESSION)!.journal
  const snapshotRoot = join(root, 'crash')
  const ownership = ownedRig!.ownProfile(snapshotRoot)
  await mkdir(snapshotRoot)
  await openTestJournalHostDatabase(root).db.backup(journalDatabasePath(snapshotRoot))
  const fresh = fakeCodex()
  const restartedAdapter = adapterFor(fresh)
  ownership.closeAdapter(() => restartedAdapter.closeAll())
  ownership.database()
  const restarted = new StructuredAgentSessionHost({
    ...host['deps'],
    adapter: restartedAdapter,
    store: ownership.store(await openTestAgentSessionRecordStore(snapshotRoot)),
    journalDatabase: openTestJournalHostDatabase(snapshotRoot),
    probeOwner: async () => ({ outcome: 'pid-absent' })
  })
  ownership.host(restarted)
  let bodyError: unknown
  let bodyFailed = false
  const cleanupErrors: unknown[] = []
  try {
    await openTestChats(restarted)
    const recovered = await restarted.journalSnapshot(SESSION)
    const reopened = restarted.collaboratorsForTests().sessions.get(SESSION)!.journal
    expect(reopened).not.toBe(journal)
    expect(continuingStructuredAgentSessionInput(reopened, id)).toBe(false)
    expect(recovered.submissions.find((s) => s.clientMessageId === id)).toMatchObject({
      dispatchState: 'unknown',
      recovered: true
    })
    expect(fresh.connections).toHaveLength(0)
  } catch (error) {
    bodyFailed = true
    bodyError = error
  } finally {
    try {
      await restarted.flushAllStreamedEvents()
    } catch (cleanup) {
      cleanupErrors.push(cleanup)
    }
  }
  if (cleanupErrors.length > 0) {
    const cleanup = cleanupErrors[0]
    if (bodyFailed) {
      throw new AggregateError([bodyError, cleanup], 'snapshot body and cleanup failed')
    }
    throw cleanup
  }
  if (bodyFailed) {
    throw bodyError
  }
}

export function codexInputFinalizationFixture() {
  return {
    host,
    adapter,
    codex,
    config,
    turns,
    events,
    failures,
    notify,
    envelope,
    permissionSend,
    began,
    submission,
    stop,
    pick,
    row,
    starts,
    assertInputRecoveredAfterSnapshot,
    restartHost: (prepare?: (journal: AgentSessionJournal) => Promise<void>) =>
      restartHost(prepare),
    conversationFence: () => host['deps'].store.getRecord(SESSION)!.lease.runtimeFence,
    waitForInputFinalization: (journal: AgentSessionJournal, id: string) =>
      vi.waitFor(() => expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(false)),
    measureInputWork: (kind: 'history' | 'close', population: number) =>
      measureCodexInputWork(host, events, kind, population)
  }
}

registerCodexInputFinalization(codexInputFinalizationFixture)

registerCodexProviderRetry(codexInputFinalizationFixture)

registerRetryCompletion(codexInputFinalizationFixture)

registerRetryCorrelation(codexInputFinalizationFixture)
