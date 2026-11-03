import { getEventListeners } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAcpAgentConnection } from '../../acp/acp-agent-connection'
import { openAcpAdapterRig } from '../../acp/acp-structured-adapter.test-support'
import { readAntigravitySignInLine } from '../../antigravity/antigravity-sign-in-url'
import { findInErrorChain } from '../../provider-process/provider-error-chain'
import { createFakePipedChild } from '../../../shared/__fixtures__/fake-spawned-child'
import { closeProviderTimelineRigs } from '../agent-session-timeline/provider-timeline-assembler-test-support'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import {
  adapterAtPublishFor,
  fakeClaude,
  identityFor,
  tick
} from '../../claude/structured/claude-structured-session-test-support'
import {
  sessionId as piSessionId,
  setup as setupPi
} from '../../pi/rpc-session-adapter.test-fixture'
import { withObservedProviderExit } from './structured-agent-session-failure-text'
import { AgentSessionStartFailure } from './structured-agent-session-start-failure'
import { CodexAppServerExitError } from '../../codex/app-server/codex-app-server-exit-error'
import { CodexAppServerRequestError } from '../../codex/app-server/codex-app-server-request-error'
import {
  adapterFor,
  fakeCodex,
  THREAD_ID
} from '../../codex/codex-structured-session-adapter-fixture'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import {
  claudeAndCodexAgents,
  claudeAndCodexRouter
} from './structured-agent-session-adapter-router-test-support'
import type * as ExitObservation from './structured-agent-session-exit-observation'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { restTestSend } from './structured-agent-session-rest-test-rig'
import type * as StartFailure from './structured-agent-session-start-failure'

// Every adapter's startup receipts and every acquisition's root-exit receipt, to count what they
// still hold after each start, whichever adapter or sink created them.
const created = vi.hoisted(() => ({
  endings: new Array<StartFailure.AgentSessionStartEndings>(),
  rootExits: new Array<ExitObservation.StructuredAgentSessionRootExitReceipt>()
}))
const retainedReceipts = () =>
  created.endings.reduce((sum, endings) => sum + endings['endings'].size, 0)
vi.mock('./structured-agent-session-start-failure', async (original) => {
  const actual = await original<typeof StartFailure>()
  class CountedEndings extends actual.AgentSessionStartEndings {
    constructor() {
      super()
      created.endings.push(this)
    }
  }
  return { ...actual, AgentSessionStartEndings: CountedEndings }
})
vi.mock('./structured-agent-session-exit-observation', async (original) => {
  const actual = await original<typeof ExitObservation>()
  class CountedRootExit extends actual.StructuredAgentSessionRootExitReceipt {
    constructor() {
      super()
      created.rootExits.push(this)
    }
  }
  return { ...actual, StructuredAgentSessionRootExitReceipt: CountedRootExit }
})

const CALLER = { callerKey: 'client-1' }
const CEILING_MS = 20_000
type Cycle = 'ready' | 'final' | 'retried' | 'expired' | 'stopped'
const CYCLES: readonly Cycle[] = ['ready', 'final', 'retried', 'expired', 'stopped']
const SCRIPTS: Record<Cycle, ('ok' | 'refuse' | 'hang')[]> = {
  ready: ['ok'],
  final: ['refuse'],
  retried: ['hang', 'ok'],
  expired: ['hang'],
  stopped: ['hang']
}

let root: string
beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
  })
  root = await mkdtemp(join(tmpdir(), 'orca-start-lifecycle-'))
  resetHostTestOperationIds()
  created.endings.length = 0
  created.rootExits.length = 0
})
afterEach(async () => {
  try {
    await closeTestJournalHostDatabases()
    await rm(root, { recursive: true, force: true })
  } finally {
    vi.useRealTimers()
    vi.restoreAllMocks()
  }
})

/** Runs `count` rounds of each start outcome through the production host, router and Codex adapter. */
async function runStarts(count: number) {
  // Each thread/start or thread/resume takes the next scripted answer.
  const answers: ('ok' | 'refuse' | 'hang')[] = []
  const threadAnswer = () => {
    const answer = answers.shift()
    if (answer === 'refuse') {
      throw new CodexAppServerRequestError('thread/start', -32600, 'invalid', 'invalid')
    }
    return answer === 'hang'
      ? new Promise(() => {})
      : { thread: { id: THREAD_ID }, model: 'gpt-live', reasoningEffort: 'medium' }
  }
  const codex = fakeCodex({ 'thread/start': threadAnswer, 'thread/resume': threadAnswer })
  let host: StructuredAgentSessionHost | undefined
  const store = await openTestAgentSessionRecordStore(join(root, `starts-${count}`))
  const adapter = adapterFor(codex, {}, [], {
    // Once a thread exists, each new child resumes it.
    resolveLaunch: async () => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: null,
      resumeThreadId: store.getRecord(SESSION)?.providerHandleChain.length ? THREAD_ID : null
    }),
    onEvent: (event) => {
      if (event.type === 'ended' && 'cause' in event) {
        void host?.handleAdapterEvent(event)
      }
    }
  })
  const other = adapterFor(fakeCodex())
  const router = claudeAndCodexRouter({ claude: other, codex: adapter }, async () => {
    await adapter.closeAll()
    await other.closeAll()
  })
  const dispatch = vi.fn(async () => ({
    state: 'accepted' as const,
    providerIdentity: {
      provider: 'codex' as const,
      threadId: THREAD_ID,
      turnId: `turn-${dispatch.mock.calls.length}`,
      ordinal: dispatch.mock.calls.length
    }
  }))
  // Turn work is not under test; every start-path call reaches the production router.
  Object.assign(router, { dispatch })
  host = new StructuredAgentSessionHost({
    agents: claudeAndCodexAgents({ claude: other, codex: adapter }),
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: router,
    journalDatabase: openTestJournalHostDatabase(join(root, `starts-${count}`)),
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${codex.connections.length}`,
    startupLimits: { ceilingMs: CEILING_MS },
    idleSweep: { intervalMs: 60 * 60_000, idleMs: 60 * 60_000 },
    now: () => NOW
  })
  const { runtimeState } = host.collaboratorsForTests()
  const spies = {
    opens: vi.spyOn(router, 'open'),
    // The router reaches every registered adapter by exact generation.
    codexEndingReads: vi.spyOn(adapter, 'startupEnding'),
    otherEndingReads: vi.spyOn(other, 'startupEnding'),
    codexRetirements: vi.spyOn(adapter, 'retireStartup'),
    otherRetirements: vi.spyOn(other, 'retireStartup'),
    timersScheduled: vi.spyOn(globalThis, 'setTimeout')
  }
  // Abort handles the host still holds, and the listeners on their signals.
  const abortSignals = () =>
    [...runtimeState.acquireAborts['inFlight'].values()].flatMap((waits) =>
      [...waits].map(({ controller }) => controller.signal)
    )
  const abortListeners = () =>
    abortSignals().reduce((sum, signal) => sum + getEventListeners(signal, 'abort').length, 0)
  const held = () => ({
    timers: vi.getTimerCount(),
    abortListeners: abortListeners(),
    abortHandles: abortSignals().length,
    trackedStarts: runtimeState.startupAttempts['open'].size,
    owners: runtimeState.startupAttempts['owners'].size,
    flights: runtimeState.startFlights['flying'].size,
    bufferedExits: runtimeState.startFlights['exits'].size,
    receipts: retainedReceipts(),
    rootExitListeners: created.rootExits.reduce((sum, exit) => sum + exit['listeners'].size, 0),
    liveChildren: codex.connections.filter((connection) => !connection.closed).length,
    // Host work still tracked or queued after its caller returned.
    trackedTasks: host!['tasks']['attaching'].size,
    queuedTasks: host!['tasks']['chains'].size
  })
  const eventually = (assertion: () => unknown) =>
    vi.waitFor(assertion, { timeout: 10_000, interval: 0 })

  const submission = async (id: string) =>
    (await host!.journalSnapshot(SESSION)).submissions.find((row) => row.clientMessageId === id)
  const failureRows = async () =>
    (await host!.journalSnapshot(SESSION)).items.filter(
      (item) => item.body.kind === 'status' && item.body.tone === 'error'
    ).length
  const phase = () => host!.collaboratorsForTests().sessions.get(SESSION)?.child?.phase
  const exitChild = (connection = codex.connections.at(-1)!) => {
    connection.closed = true
    const exit = new CodexAppServerExitError('codex app-server connection ended')
    // A duplicate terminal report must change nothing.
    connection.handlers.onExit?.(exit, { expected: false })
    connection.handlers.onExit?.(exit, { expected: false })
  }

  // Work the starts did, counted from a ready chat.
  const work = async (): Promise<Record<string, number>> => ({
    ...Object.fromEntries(
      Object.entries(spies).map(([field, spy]) => [field, spy.mock.calls.length])
    ),
    spawns: codex.connections.length,
    failureRows: await failureRows()
  })

  answers.push('ok')
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
  await eventually(() => expect(phase()).toBe('ready'))
  const begun = await work()
  const after: Record<Cycle, ReturnType<typeof held>[]> = {
    ready: [],
    final: [],
    retried: [],
    expired: [],
    stopped: []
  }
  let rows = 0
  // What a Stopped start holds while its child's cleanup is still running.
  const stopping: ReturnType<typeof held>[] = []
  // What one start holds while its child is still answering.
  const starting: ReturnType<typeof held>[] = []
  for (let round = 0; round < count; round++) {
    for (const cycle of CYCLES) {
      // The chat's ready child dies, so the next message starts a new one as the script says.
      if (phase() === 'ready') {
        exitChild()
        await eventually(() => expect(phase()).toBeUndefined())
      }
      await host.flushStreamedEvents(SESSION)
      rows = await failureRows()
      const spawned = codex.connections.length
      answers.push(...SCRIPTS[cycle])
      const send = restTestSend(cycle, store.getRecord(SESSION)!.lease.runtimeFence)
      expect(await host.send(CALLER, send), `${cycle} ${round}`).toMatchObject({ ok: true })
      if (cycle === 'retried') {
        await eventually(() => expect(answers).toEqual(['ok']))
        starting.push(held())
        exitChild()
      }
      if (cycle === 'expired') {
        await eventually(() => expect(answers).toEqual([]))
        await vi.advanceTimersByTimeAsync(CEILING_MS)
      }
      if (cycle === 'stopped') {
        await eventually(() => expect(answers).toEqual([]))
        // The user stops the start while its open waits; the child's cleanup is held, then ends.
        const connection = codex.connections.at(-1)!
        const close = connection.close
        const cleanup = Promise.withResolvers<void>()
        connection.close = async () => {
          await cleanup.promise
          return close()
        }
        const fence = store.getRecord(SESSION)!.lease.runtimeFence
        const stop = {
          sessionId: SESSION,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: fence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.cancel',
            sessionId: SESSION,
            fields: {}
          })
        }
        const stopped = host.cancel(CALLER, { envelope: stop })
        await vi.advanceTimersByTimeAsync(100)
        stopping.push(held())
        cleanup.resolve()
        expect(await stopped).toMatchObject({ ok: true })
      }
      // The start's owner decides it: the message runs on a ready child, or one row says why not.
      const started = cycle === 'ready' || cycle === 'retried'
      await eventually(async () => {
        await vi.advanceTimersByTimeAsync(100)
        expect(runtimeState.startFlights.has(SESSION)).toBe(false)
        expect(phase(), `${cycle} ${round}`).toBe(started ? 'ready' : undefined)
        expect((await submission(send.envelope.clientOperationId))?.dispatchState).toBe(
          started ? 'accepted' : 'rejected'
        )
        expect(await failureRows()).toBe(rows + (cycle === 'final' || cycle === 'expired' ? 1 : 0))
      })
      expect(codex.connections).toHaveLength(spawned + (cycle === 'retried' ? 2 : 1))
      await host.flushStreamedEvents(SESSION)
      await vi.advanceTimersByTimeAsync(2_000)
      after[cycle].push(held())
    }
  }
  const done = await work()
  await host.close(SESSION, 'evict')
  await host.flushAllStreamedEvents()
  await router.closeAll()
  vi.restoreAllMocks()
  const counts = Object.fromEntries(
    Object.entries(done).map(([field, count]) => [field, count - begun[field]])
  )
  return { after, starting, stopping, counts }
}

it('returns every start resource to baseline and does constant work per start, at N and 10N', async () => {
  const n = await runStarts(1)
  const tenN = await runStarts(10)
  for (const cycle of CYCLES) {
    const [first] = n.after[cycle]
    // Nothing a finished start owned survives it: no owner, abort handle, tracked attempt, flight,
    // buffered exit, adapter receipt, root-exit listener or tracked task, and no exited child left
    // running.
    expect(first, cycle).toMatchObject({
      abortHandles: 0,
      trackedStarts: 0,
      owners: 0,
      flights: 0,
      bufferedExits: 0,
      receipts: 0,
      rootExitListeners: 0,
      liveChildren: cycle === 'ready' || cycle === 'retried' ? 1 : 0,
      trackedTasks: 0,
      queuedTasks: 0
    })
    // Timers and abort listeners held after each start do not grow with the starts before it.
    for (const held of tenN.after[cycle]) {
      expect(held, cycle).toEqual(first)
    }
  }
  // While a start waits on its child it holds a fixed set, however many starts came before it:
  // one deadline timer, the flight's and the owner's abort handles, one tracked attempt, owner,
  // receipt and root-exit subscription.
  expect(n.starting[0]).toMatchObject({
    timers: n.after.ready[0].timers + 1,
    abortHandles: 2,
    trackedStarts: 1,
    owners: 1,
    flights: 1,
    receipts: 1,
    rootExitListeners: 1
  })
  for (const held of tenN.starting) {
    expect(held).toEqual(n.starting[0])
  }
  // A Stop releases the start's owner at once; while its child's cleanup is held, that cleanup is
  // the one task still tracked and queued, however many Stops came before it.
  expect(n.stopping[0]).toMatchObject({
    owners: 0,
    flights: 0,
    abortHandles: 0,
    receipts: 0,
    trackedTasks: 1,
    queuedTasks: 1,
    liveChildren: 1
  })
  for (const held of tenN.stopping) {
    expect(held).toEqual(n.stopping[0])
  }
  // Per round of five starts: six spawns and opens (the retried start opens twice) and a failure
  // row for the final and the expired start; a Stopped start reads no ending. Router reads and
  // retirements reach the registered adapters a fixed number of times per open, whatever the
  // starts before it.
  expect(n.counts).toMatchObject({
    spawns: 6,
    opens: 6,
    codexEndingReads: 4,
    otherEndingReads: 4,
    codexRetirements: 6,
    otherRetirements: 6,
    failureRows: 2
  })
  for (const [field, count] of Object.entries(n.counts)) {
    expect(tenN.counts[field], field).toBe(count * 10)
  }
})

/** Starts an ACP agent that prints a sign-in line Orca cannot read, `count` times. */
async function refuseAcpStarts(count: number) {
  const connections: ReturnType<typeof createAcpAgentConnection>[] = []
  const refusals = new Map<ReturnType<typeof createAcpAgentConnection>, Error>()
  const rig = await openAcpAdapterRig({
    deps: {
      connect: (launch, options) => {
        const child = Object.assign(createFakePipedChild(), {
          pid: 9_999_999,
          stdout: new PassThrough(),
          stdin: new PassThrough(),
          stderr: new PassThrough(),
          kill: () => true
        })
        // Orca's cleanup ends stdin; the agent then exits.
        child.stdin.once('finish', () => child.emit('exit', 0, null))
        const connection: ReturnType<typeof createAcpAgentConnection> = createAcpAgentConnection(
          launch,
          {
            ...options,
            onClose: (error) => {
              if (!refusals.has(connection)) {
                refusals.set(connection, error)
              }
              options.onClose?.(error)
            },
            signIn: { read: readAntigravitySignInLine }
          },
          () => child
        )
        connections.push(connection)
        child.stdout.write('Open the following link to authenticate the ACP server: not-a-url\n')
        return connection
      }
    }
  })
  const retained: number[] = []
  try {
    for (let index = 0; index < count; index++) {
      const error = await rig.acquire({ waitForStart: false }).catch((caught: unknown) => caught)
      const connection = connections[index]
      // The verdict is final and carries this connection's own first refusal, not a later close.
      const verdict = findInErrorChain(error, (cause) =>
        cause instanceof AgentSessionStartFailure ? cause : undefined
      )
      expect(verdict?.retry).toBe('never')
      expect(verdict?.cause).toBe(refusals.get(connection))
      expect(connection.lostBeforeExit).toBe(refusals.get(connection))
      expect(connection.exited).toBe(true)
      retained.push(retainedReceipts())
    }
    return { spawns: connections.length, retained }
  } finally {
    await rig.adapter.closeAll()
    await closeProviderTimelineRigs()
  }
}

it('ACP: each refused start keeps its own cause and leaves no receipt or child, at N and 10N', async () => {
  vi.useRealTimers()
  for (const count of [10, 100]) {
    const { spawns, retained } = await refuseAcpStarts(count)
    expect(spawns).toBe(count)
    expect(retained).toEqual(Array(count).fill(0))
  }
})

/** What a real Claude or Pi adapter keeps from `count` starts of each ending, retired by the
 *  start's owner as the host does: a ready start, and one whose agent exited before its open. */
async function adapterStarts(
  agent: 'claude' | 'pi',
  count: number
): Promise<{ left: Record<string, number>[]; spawns: number }> {
  const harness = agent === 'claude' ? await claudeStarts() : await piStarts()
  const left: Record<string, number>[] = []
  try {
    for (let round = 0; round < count; round++) {
      for (const exitsFirst of [false, true]) {
        const generation = await harness.acquire()
        if (exitsFirst) {
          harness.exitChild()
        }
        const opened = await harness.open(generation).then(
          () => 'ready',
          (error: unknown) => error
        )
        if (exitsFirst) {
          // The open answers with the ending the exit left, a verdict the owner can act on.
          expect(opened).toBeInstanceOf(AgentSessionStartFailure)
        } else {
          expect(opened).toBe('ready')
        }
        harness.adapter.retireStartup?.(harness.sessionId, generation)
        // Retired by its owner, even while a ready start's session stays live.
        const receipts = retainedReceipts()
        await harness.adapter.closeSession(harness.sessionId)
        await harness.settle()
        left.push({ receipts, ...harness.held() })
      }
    }
    return { left, spawns: harness.spawns() }
  } finally {
    await harness.adapter.closeAll()
    await closeProviderTimelineRigs()
  }
}

async function claudeStarts() {
  const claude = fakeClaude()
  const adapter = adapterAtPublishFor(claude)
  const sessionId = identityFor().sessionId
  return {
    adapter,
    sessionId,
    acquire: async () =>
      (await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'perf' }))
        .acquisitionGeneration,
    open: (acquisitionGeneration: string) =>
      adapter.open({
        sessionId,
        fence: 7,
        acquisitionGeneration,
        signal: new AbortController().signal
      }),
    exitChild: () => {
      const connection = claude.connections.at(-1)!
      connection.closed = true
      connection.exitVerdict = { root: 'exited', tree: 'exited' }
      connection.handlers.onExit?.(withObservedProviderExit(new Error('claude exited')), {
        expected: false
      })
    },
    settle: async () => {
      adapter.acknowledgeSessionRelease?.(sessionId)
      await tick()
    },
    held: () => ({
      sessions: adapter['sessions'].size,
      acquisitions: adapter['acquisitions']['attempts'].size,
      exits: adapter['exits'].size
    }),
    spawns: () => claude.connections.length
  }
}

async function piStarts() {
  const pi = await setupPi()
  const { adapter, input, connections } = pi
  await adapter.closeSession(piSessionId)
  return {
    adapter,
    sessionId: piSessionId,
    acquire: async () => (await adapter.acquire(input)).acquisitionGeneration,
    open: (acquisitionGeneration: string) =>
      adapter.open({
        sessionId: piSessionId,
        fence: 7,
        acquisitionGeneration,
        signal: new AbortController().signal
      }),
    exitChild: () => connections.at(-1)!.exit(),
    settle: async () => {
      await adapter.drainObservedExits()
      adapter.acknowledgeSessionRelease(piSessionId)
    },
    held: () => ({
      sessions: adapter['sessions'].size,
      rootExitListeners: connections.reduce(
        (sum, connection) => sum + connection['exitListeners'].length,
        0
      )
    }),
    spawns: () => connections.length
  }
}

it.each(['claude', 'pi'] as const)(
  '%s: each start retires its receipt and exit subscription, at N and 10N',
  async (agent) => {
    vi.useRealTimers()
    const n = await adapterStarts(agent, 10)
    const tenN = await adapterStarts(agent, 100)
    const settled =
      agent === 'claude'
        ? { sessions: 0, acquisitions: 0, exits: 0 }
        : { sessions: 0, rootExitListeners: 0 }
    for (const held of [...n.left, ...tenN.left]) {
      expect(held).toEqual({ receipts: 0, ...settled })
    }
    expect(tenN.spawns - (agent === 'pi' ? 1 : 0)).toBe(10 * (n.spawns - (agent === 'pi' ? 1 : 0)))
  }
)
