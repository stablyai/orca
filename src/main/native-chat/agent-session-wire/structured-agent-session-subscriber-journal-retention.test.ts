import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { MAX_TIMER_DELAY_MS } from '../../../shared/timer-delay'
import { codexItemBody } from '../../codex/codex-structured-item-translation'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../../runtime/rpc/methods/structured-agent-session'
import { setStructuredAgentSessionHost } from './structured-agent-session-registry'
import { hostTestAttachParams } from './structured-agent-session-host-test-data'
import {
  createRestTestRig,
  IDLE_MS,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  REST_TEST_THREAD as THREAD,
  sweepOnce,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'

const COMMAND_COUNT = 64
const OUTPUT_BYTES = 8 * 1024
let rig: RestTestRig
let controllers: AbortController[]

function observer() {
  const types: string[] = []
  const state = { types, sawSeed: false, sawFuture: false }
  return {
    state,
    emit: (event: unknown): void => {
      if (
        !event ||
        typeof event !== 'object' ||
        !('type' in event) ||
        typeof event.type !== 'string'
      ) {
        throw new Error('Subscriber received an invalid event')
      }
      state.types.push(event.type)
      const text = JSON.stringify(event)
      state.sawSeed ||= text.includes('command-00000')
      state.sawFuture ||= text.includes('after idle')
    }
  }
}

async function collect(): Promise<void> {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 5; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

async function seedFold() {
  const attached = await rig.host.attach(
    CALLER,
    hostTestAttachParams(null, {
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'folder'
      }
    })
  )
  if (!attached.ok) {
    throw new Error('Fixture attach was refused')
  }
  await rig.store.setSessionTabVisibility(SESSION, true)
  const events = rig.adapter.acquire.mock.calls.at(-1)?.[0].events
  if (!events) {
    throw new Error('Fixture provider did not acquire an event sink')
  }
  const digest = createHash('sha256')
  for (let index = 0; index < COMMAND_COUNT; index += 1) {
    const output = `command-${index.toString().padStart(5, '0')}\n${'x'.repeat(OUTPUT_BYTES - 14)}`
    const body = codexItemBody({
      type: 'commandExecution',
      id: `command-${index}`,
      status: 'completed',
      command: 'cat progress.log',
      cwd: '/workspace',
      aggregatedOutput: output,
      exitCode: 0
    })
    if (body?.kind !== 'tool-call' || body.output?.head !== output || body.output.truncated) {
      throw new Error('Fixture output was clipped')
    }
    digest.update(output)
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'completed-turn', ordinal: index + 100 },
      body,
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    if (index % 16 === 15) {
      await rig.host.flushStreamedEvents(SESSION)
    }
  }
  await rig.host.flushStreamedEvents(SESSION)
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!journal) {
    throw new Error('Fixture conversation was not opened')
  }
  return { journal: new WeakRef(journal), digest: digest.digest('hex') }
}

async function subscribeOverRpc(reader: ReturnType<typeof observer>): Promise<AbortController> {
  const controller = new AbortController()
  controllers.push(controller)
  const dispatcher = new RpcDispatcher({
    runtime: new OrcaRuntimeService(),
    methods: STRUCTURED_AGENT_SESSION_METHODS
  })
  await dispatcher.dispatchStreaming(
    {
      id: 'frame-1',
      authToken: 'token',
      method: 'agentSession.subscribe',
      params: { sessionId: SESSION }
    },
    (raw) => {
      const frame: unknown = JSON.parse(raw)
      if (
        !frame ||
        typeof frame !== 'object' ||
        !('ok' in frame) ||
        frame.ok !== true ||
        !('result' in frame)
      ) {
        throw new Error('Subscription RPC failed')
      }
      reader.emit(frame.result)
    },
    {
      clientId: 'client-1',
      clientKind: 'runtime',
      clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
      connectionId: 'connection-1',
      signal: controller.signal
    }
  )
  return controller
}

function subscriberCount(): number {
  return rig.host.collaboratorsForTests().subscribers.subscriberCountForTests(SESSION)
}

async function restoreDurableHistory(expectedDigest: string): Promise<void> {
  const history = await rig.host.history({ sessionId: SESSION, direction: 'tail', limit: 100 })
  const digest = createHash('sha256')
  let commands = 0
  let bytes = 0
  for (const item of history.page.items) {
    if (item.body.kind !== 'tool-call') {
      continue
    }
    const output = item.body.output
    if (!output || output.truncated) {
      throw new Error('Durable output was lost or clipped')
    }
    commands += 1
    bytes += Buffer.byteLength(output.head)
    digest.update(output.head)
  }
  expect(commands).toBe(COMMAND_COUNT)
  expect(bytes).toBe(COMMAND_COUNT * OUTPUT_BYTES)
  expect(digest.digest('hex')).toBe(expectedDigest)
}

async function publishAfterIdle(id: string): Promise<void> {
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!journal) {
    throw new Error('History did not reopen the conversation')
  }
  await journal.appendItem(
    { provider: 'orca', clientMessageId: id },
    { kind: 'status', text: 'after idle' },
    {
      fence: rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
}

beforeEach(async () => {
  controllers = []
  rig = await createRestTestRig({ idleSweep: { intervalMs: MAX_TIMER_DELAY_MS } })
  setStructuredAgentSessionHost(rig.host)
})

afterEach(async () => {
  for (const controller of controllers) {
    controller.abort()
  }
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.restoreAllMocks()
})

describe('subscriber journal lifetime', () => {
  it('releases an idle fold while its owned RPC reader stays live and resumes on the durable journal', async () => {
    const seeded = await seedFold()
    const reader = observer()
    const controller = await subscribeOverRpc(reader)
    expect(reader.state.sawSeed).toBe(true)
    expect(subscriberCount()).toBe(1)
    // Provider mock call history owns the event sink; remove that fixture root before GC.
    vi.clearAllMocks()
    rig.statusEvents.length = 0
    await collect()
    expect(seeded.journal.deref() !== undefined).toBe(true)

    rig.clock.now += IDLE_MS + 1
    await sweepOnce(rig.host)
    expect(rig.host.hasSession(SESSION)).toBe(false)
    expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION)
    expect(subscriberCount()).toBe(1)
    expect(reader.state.types).not.toContain('end')
    vi.clearAllMocks()
    rig.statusEvents.length = 0
    await collect()
    const releasedWhileSubscribed = seeded.journal.deref() === undefined

    await restoreDurableHistory(seeded.digest)
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
    const sibling = observer()
    const disposeSibling = await rig.host.subscribe({
      id: 'new-reader',
      sessionId: SESSION,
      emit: sibling.emit
    })
    expect(sibling.state.sawSeed).toBe(true)
    expect(subscriberCount()).toBe(2)
    await publishAfterIdle('first-publication')
    await vi.waitFor(() => expect(reader.state.sawFuture && sibling.state.sawFuture).toBe(true))

    controller.abort()
    expect(subscriberCount()).toBe(1)
    expect(reader.state.types.filter((type) => type === 'end')).toHaveLength(1)
    const endedFrames = reader.state.types.length
    const siblingFrames = sibling.state.types.length
    await publishAfterIdle('second-publication')
    await vi.waitFor(() => expect(sibling.state.types.length).toBeGreaterThan(siblingFrames))
    expect(reader.state.types).toHaveLength(endedFrames)
    disposeSibling()
    disposeSibling()
    expect(subscriberCount()).toBe(0)
    expect(sibling.state.types.filter((type) => type === 'end')).toHaveLength(1)
    await collect()
    expect(seeded.journal.deref() === undefined).toBe(true)
    expect(releasedWhileSubscribed).toBe(true)
  })

  it('keeps direct cleanup tied to its original subscriber after the caller changes its input', async () => {
    const seeded = await seedFold()
    const ended = observer()
    const kept = observer()
    const input = { id: 'direct-reader', sessionId: SESSION, emit: ended.emit }
    const dispose = await rig.host.subscribe(input)
    const disposeKept = await rig.host.subscribe({
      id: 'kept-reader',
      sessionId: SESSION,
      emit: kept.emit
    })
    input.id = 'kept-reader'
    input.sessionId = 'other-session'
    vi.clearAllMocks()
    rig.clock.now += IDLE_MS + 1
    await sweepOnce(rig.host)
    expect(subscriberCount()).toBe(2)
    await restoreDurableHistory(seeded.digest)
    dispose()
    dispose()
    expect(subscriberCount()).toBe(1)
    expect(ended.state.types.filter((type) => type === 'end')).toHaveLength(1)
    expect(kept.state.types).not.toContain('end')
    await publishAfterIdle('direct-publication')
    await vi.waitFor(() => expect(kept.state.sawFuture).toBe(true))
    expect(ended.state.sawFuture).toBe(false)
    disposeKept()
    expect(subscriberCount()).toBe(0)
  })
})
