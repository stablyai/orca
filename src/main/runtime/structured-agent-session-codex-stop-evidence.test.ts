import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { AGENT_SESSION_GOAL_CONTROL_COPY as COPY } from '../../shared/agent-session-goal-control-copy'
import { openCodexAppServerConnection } from '../codex/codex-app-server-connection'
import { codexTurnLifecycleFake } from '../codex/codex-turn-lifecycle-fake'
import { CODEX_SCRIPTED_THREAD as THREAD } from '../codex/codex-scripted-child.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { AgentSessionRecordStore } from './agent-session-record-store'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import type { DescendantSnapshot } from '../pty-descendant-termination'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import type { AgentSessionStopOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter-stop'
import { agentVerdictDisplayMark } from '../../shared/agent-main-agent-verdict'
import { activeProviderContext } from '../../shared/agent-session-provider-context'

const os = vi.hoisted(() => ({
  capture: vi.fn<(pid: number) => Promise<DescendantSnapshot | null>>(),
  terminate: vi.fn<() => Promise<DescendantTreeVerdict>>()
}))
vi.mock('../pty-descendant-termination', () => ({ captureDescendantSnapshot: os.capture }))
vi.mock('../pty-descendant-exit-verification', () => ({
  terminateDescendantSnapshotWithVerdict: os.terminate
}))
vi.mock('../crash-reporting/self-initiated-tree-kill-log', () => ({
  recordSelfInitiatedTreeKill: vi.fn()
}))

async function pipedChat() {
  const directory = await mkdtemp(join(tmpdir(), 'orca-codex-stop-evidence-'))
  const children: ReturnType<typeof createFakePipedChild>[] = []
  const connections: Awaited<ReturnType<typeof openCodexAppServerConnection>>[] = []
  const delivered = new Set<number>()
  const prompts: string[] = []
  let operation = 0,
    pauseFails = false,
    interruptFails = false,
    natural = false
  let permitKill = true
  const emit = (index: number, frame: unknown) =>
    children[index]!.stdout.write(`${JSON.stringify(frame)}\n`)
  const signal = vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
    const index = children.findIndex((child) => child.pid + 1 === -pid)
    if (index !== -1 && sig === 'SIGKILL' && permitKill) {
      delivered.add(index)
      return true
    }
    throw Object.assign(new Error('fixture group absent'), { code: 'ESRCH' })
  })
  const host = await ensureStructuredAgentSessionHost({
    stateDirectory: directory,
    hostId: 'local',
    claimKeyId: 'key-1',
    logger: { warn: vi.fn(), error: vi.fn() },
    resolveWorkspacePath: async () => directory,
    resolveCodexCommand: () => ({ command: '/fixture/codex', prefixArgs: [] }),
    resolveLaunchArgs: () => [],
    resolveEnvironment: async () => ({}),
    resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
    readProcessStartTime: async () => 1700000000000,
    openCodexConnection: async (launch, handlers) => {
      const index = children.length
      const child = createFakePipedChild(9200000 + index * 100)
      child.kill.mockImplementation(() => false)
      Object.assign(child, { exitCode: null, signalCode: null, killed: false })
      children.push(child)
      const notify = (method: string, params: unknown) => emit(index, { method, params })
      const turns = codexTurnLifecycleFake(THREAD, () => notify)
      child.stdin.on('finish', () => {
        if (natural) {
          child.emit('exit', 0, null)
        }
      })
      let pending = ''
      child.stdin.on('data', (bytes) => {
        pending += String(bytes)
        for (;;) {
          const boundary = pending.indexOf('\n')
          if (boundary === -1) {
            break
          }
          const frame = JSON.parse(pending.slice(0, boundary))
          pending = pending.slice(boundary + 1)
          if (frame.id === undefined) {
            continue
          }
          const { id, method, params } = frame
          if (
            (method === 'thread/goal/set' && pauseFails) ||
            (method === 'turn/interrupt' && interruptFails)
          ) {
            emit(index, { id, error: { code: -32602, message: 'genuine provider refusal' } })
            continue
          }
          let result: unknown = {}
          if (method === 'thread/start' || method === 'thread/resume') {
            result = { thread: { id: THREAD }, model: 'scripted-model' }
          }
          if (method === 'model/list') {
            result = {
              data: [{ model: 'scripted-model', isDefault: true, supportedReasoningEfforts: [] }],
              nextCursor: null
            }
          }
          if (method === 'thread/goal/get') {
            result = { goal: pauseFails ? { status: 'active' } : null }
          }
          if (method === 'turn/start') {
            prompts.push(JSON.stringify(params.input))
            result = turns.routes['turn/start']()
            turns.start()
            turns.echo(params.clientUserMessageId)
            if (index > 0) {
              notify('item/completed', {
                threadId: THREAD,
                turnId: turns.turnId,
                item: { id: `reply-${index}`, type: 'agentMessage', text: 'Healthy next reply' }
              })
              turns.end('completed')
            }
          }
          if (method === 'turn/interrupt') {
            result = turns.routes['turn/interrupt'](params)
          }
          emit(index, { id, result })
        }
      })
      const connection = await openCodexAppServerConnection(launch, handlers, () => child)
      connections.push(connection)
      return connection
    }
  })
  const caller = { callerKey: 'codex-stop-evidence' }
  const record = () => host.deps.store.getRecord(SESSION)!
  const envelope = (method: string, fields: Record<string, unknown>) => ({
    sessionId: SESSION,
    clientOperationId: `${Date.now()}-${(++operation).toString(16).padStart(32, '0')}`,
    expectedRuntimeFence: record().lease.runtimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  })
  const send = (text: string) => {
    const body = hostTestMessage(text)
    return host.send(caller, { body, envelope: envelope('agentSession.send', { body }) })
  }
  const drain = () => host.collaboratorsForTests().serialize(SESSION, async () => {})
  return {
    host,
    directory,
    children,
    connections,
    delivered,
    signal,
    record,
    caller,
    send,
    drain,
    stop: () => host.cancel(caller, { envelope: envelope('agentSession.cancel', {}) }),
    setPauseFailure: () => {
      pauseFails = true
    },
    setInterruptFailure: () => {
      interruptFails = true
    },
    natural: () => {
      natural = true
    },
    undelivered: () => {
      permitKill = false
    },
    start: async () => {
      const params = hostTestAttachParams(null, {
        providerHandle: undefined,
        accountHome: { variable: 'CODEX_HOME', path: join(directory, 'codex') }
      })
      params.envelope.clientOperationId = `${Date.now()}-${(++operation).toString(16).padStart(32, '0')}`
      const attached = await host.attach(caller, params)
      expect(attached, JSON.stringify(attached)).toMatchObject({ ok: true })
      await vi.waitFor(() =>
        expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready')
      )
      expect(await send('Hold this turn for Stop')).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(prompts).toHaveLength(1))
      await host.flushStreamedEvents(SESSION)
    },
    healthy: async () => {
      expect(await send('A legitimate next message')).toMatchObject({ ok: true })
      await vi.waitFor(async () => {
        const snapshot = await host.journalSnapshot(SESSION)
        expect(snapshot.submissions.at(-1)?.dispatchState).toBe('accepted')
        expect(JSON.stringify(snapshot.items)).toContain('Healthy next reply')
      })
      expect(prompts).toHaveLength(2)
    },
    reopen: async () => {
      const database = JournalHostDatabase.open(directory)
      try {
        const store = AgentSessionRecordStore.open({
          journalDatabase: database,
          hostId: 'local',
          legacySessionTabIds: []
        })
        const journal = new AgentSessionJournal({
          database,
          identity: {
            sessionId: SESSION,
            workspaceId: 'workspace-1',
            hostId: 'local',
            agent: 'codex',
            providerHandle: activeProviderContext(record()).head?.handle ?? null
          }
        })
        await journal.open()
        const snapshot = journal.snapshot()
        await journal.close()
        return { record: store.getRecord(SESSION), snapshot }
      } finally {
        database.close()
      }
    },
    dispose: async () => {
      children.forEach((child) => {
        child.emit('exit', 0, null)
        child.stdout.end()
        child.emit('close', 0, null)
      })
      await stopStructuredAgentSessionRuntime()
      signal.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  }
}
let fixture: Awaited<ReturnType<typeof pipedChat>>
beforeEach(async () => {
  os.capture.mockImplementation(async (pid) => ({
    rootPgid: pid,
    capturedAtMs: 1,
    root: { pid, startedAt: 'Mon Jan 1 00:00:00 2026' },
    descendants: [{ pid: pid + 1, ppid: pid, pgid: pid + 1, startedAt: 'Mon Jan 1 00:00:00 2026' }]
  }))
  os.terminate.mockResolvedValue('exited')
  fixture = await pipedChat()
})
afterEach(async () => {
  vi.useRealTimers()
  await fixture.dispose()
  vi.restoreAllMocks()
})
const forceTime = () => vi.advanceTimersByTimeAsync(20_000)
const warnings = (items: Awaited<ReturnType<typeof fixture.host.journalSnapshot>>['items']) =>
  items.filter(
    (item) => item.body.kind === 'status' && item.body.failure?.kind === 'cancelUnconfirmed'
  )

it.each(['fresh', 'cached-before-ack', 'retired-before-join'] as const)(
  'uses exact delivered writer evidence for %s Stop without inventing root exit',
  async (mode) => {
    await fixture.start()
    const old = fixture.host.collaboratorsForTests().sessions.get(SESSION)!.child!
    const adapter = fixture.host.deps.adapter
    const acknowledge = vi.spyOn(adapter, 'acknowledgeSessionRelease')
    const events = vi.spyOn(fixture.host, 'handleAdapterEvent')
    let outcome: AgentSessionStopOutcome | undefined
    const cancel = adapter.cancelTurn.bind(adapter)
    vi.spyOn(adapter, 'cancelTurn').mockImplementation(async (input) => {
      const result = await cancel(input)
      outcome = result.stop
      return result
    })
    const observe = vi.spyOn(adapter, 'disposeSession')
    const awaitStoppedRequestEnd = adapter.awaitStoppedRequestEnd!.bind(adapter)
    const reached = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>()
    if (mode !== 'fresh') {
      vi.spyOn(adapter, 'awaitStoppedRequestEnd').mockImplementation(async (id, at) => {
        await awaitStoppedRequestEnd(id, at)
        reached.resolve()
        await resume.promise
      })
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    expect(await fixture.stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    await vi.advanceTimersByTimeAsync(0)
    if (mode !== 'fresh') {
      await reached.promise
      const closing =
        mode === 'cached-before-ack'
          ? adapter.closeSession!(SESSION).catch((error) => error)
          : fixture.host
              .collaboratorsForTests()
              .lifetime.stopAgent(SESSION, { recorded: 'user-stop' })
      await forceTime()
      await closing
      expect(acknowledge).toHaveBeenCalledTimes(mode === 'cached-before-ack' ? 0 : 1)
      expect(events.mock.calls).toContainEqual([
        expect.objectContaining({
          type: 'ended',
          fence: old.fence,
          acquisitionGeneration: old.generation,
          deathEvidenceKind: 'kill-delivered',
          processExit: { root: 'live', workload: 'exited' }
        })
      ])
      expect(fixture.connections[0]!.closeResult).toEqual({
        root: 'live',
        tree: 'exited',
        killDelivered: true
      })
      const signals = fixture.signal.mock.calls.length
      resume.resolve()
      await fixture.drain()
      expect(fixture.signal.mock.calls).toHaveLength(signals)
    } else {
      await forceTime()
      await fixture.drain()
    }
    expect(fixture.connections[0]!.closeResult).toEqual({
      root: 'live',
      tree: 'exited',
      killDelivered: true
    })
    expect(fixture.delivered).toEqual(new Set([0]))
    expect(fixture.record().lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null,
      reservedSpawnToken: null,
      handoffStage: null,
      deathEvidence: { kind: 'kill-delivered', ownerFence: old.fence }
    })
    const status = fixture.host.readStatusSummary(SESSION)
    expect(status).toMatchObject({ status: 'idle', turnOutcome: 'cancellation' })
    expect(
      agentVerdictDisplayMark({
        state: 'done',
        mainAgent: { state: 'done', outcome: status?.turnOutcome }
      })
    ).toBe('interrupted')
    const reopened = await fixture.reopen()
    expect(reopened.record?.lease.deathEvidence?.kind).toBe('kill-delivered')
    expect(warnings(reopened.snapshot.items)).toEqual([])
    expect(outcome).toEqual({
      pause: 'acknowledged',
      interrupt: 'accepted',
      root: 'unproven',
      workload: 'exited',
      deathEvidenceKind: 'kill-delivered',
      errors: []
    })
    expect(observe).toHaveBeenCalledOnce()
    expect(acknowledge).toHaveBeenCalledOnce()
    vi.useRealTimers()
    await fixture.healthy()
    const successor = fixture.record().lease
    fixture.children[0]!.emit('exit', 0, null)
    await fixture.drain()
    expect(fixture.record().lease).toEqual(successor)
    expect(
      fixture.host.deps.store.listOperationRows().some((row) => row.outcome.status === 'pending')
    ).toBe(false)
  }
)

it('retains an undelivered Stop and its feedback until a legitimate exit wakes next input', async () => {
  await fixture.start()
  fixture.undelivered()
  os.terminate.mockResolvedValue('unverifiable')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  expect(await fixture.stop()).toMatchObject({ ok: true })
  await forceTime()
  await fixture.drain()
  expect(fixture.connections[0]!.closeResult).toEqual({ root: 'live', tree: 'unverifiable' })
  expect(fixture.record().lease.claimStatus).toBe('live')
  expect(fixture.record().lease.deathEvidence).toBeNull()
  expect(warnings((await fixture.reopen()).snapshot.items)).toHaveLength(1)
  fixture.children[0]!.emit('exit', 0, null)
  await fixture.drain()
  expect(fixture.record().lease.deathEvidence?.kind).toBe('exit-observed')
  vi.useRealTimers()
  await fixture.healthy()
  expect(warnings((await fixture.reopen()).snapshot.items)).toHaveLength(1)
})

it.each(['pause', 'interrupt', 'wait-error', 'workload', 'natural-workload'] as const)(
  'retains independent %s uncertainty after writer termination',
  async (failure) => {
    await fixture.start()
    if (failure === 'pause') {
      fixture.setPauseFailure()
    }
    if (failure === 'interrupt') {
      fixture.setInterruptFailure()
    }
    if (failure === 'wait-error') {
      const awaitStoppedRequestEnd = fixture.host.deps.adapter.awaitStoppedRequestEnd!.bind(
        fixture.host.deps.adapter
      )
      vi.spyOn(fixture.host.deps.adapter, 'awaitStoppedRequestEnd').mockImplementation(
        async (id, at) => {
          await awaitStoppedRequestEnd(id, at)
          throw new Error('genuine request settlement failure')
        }
      )
    }
    if (failure === 'workload' || failure === 'natural-workload') {
      os.terminate.mockResolvedValue('unverifiable')
    }
    if (failure === 'natural-workload') {
      fixture.natural()
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    expect(await fixture.stop()).toMatchObject({ ok: true })
    await forceTime()
    await fixture.drain()
    const rows = warnings((await fixture.reopen()).snapshot.items)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.body).toMatchObject({
      text: failure === 'pause' ? COPY.pauseUnconfirmed : COPY.stopUnconfirmed
    })
    expect(fixture.record().lease.deathEvidence?.kind).toBe(
      failure === 'natural-workload' ? 'exit-observed' : 'kill-delivered'
    )
  }
)
