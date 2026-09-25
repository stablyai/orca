// A child that dies between spawn and journal attach can still write through the host's event
// sink, which attach unbound and never re-bound. That queue must die with the failed create, or
// the next attach's drain barrier and shutdown's flush wait on it forever.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  AgentSessionPreSpawnError,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestLaunchDirectory,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }
const EXIT_REASON = 'claude stream-json exited (code 1): claude: not signed in'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-failed-create-sink-'))
  resetHostTestOperationIds()
  acquire = vi.fn(async ({ fence, spawnToken }) => ({
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
    link: {
      linkId: `link-${fence}`,
      handle: { provider: 'codex', threadId: THREAD },
      // A resume continues the chain the first start created.
      origin: store.getRecord(SESSION)?.providerHandleChain.length ? 'resumed' : 'created',
      mintedAtFence: fence,
      observedAt: NOW
    },
    acquisitionGeneration: `generation-${fence}`
  }))
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire,
      releaseAcquisition: vi.fn(async () => true),
      dispatch: vi.fn(async () => ({ state: 'admitted' as const })),
      cancelTurn: vi.fn(async () => ({ cancelled: true })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    journalRoot: root,
    claimKeyId: 'key-1',
    resolveLaunchDirectory: hostTestLaunchDirectory,
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('a create that fails after its child wrote through the unbound sink', () => {
  it.each([
    // The common failed start: answered as a refusal.
    ['refused', new Error(EXIT_REASON)],
    // A failure the attach cannot classify still throws, and must release the sink too.
    ['thrown', new AgentSessionPreSpawnError(new Error(EXIT_REASON))]
  ])(
    'releases the sink when %s, so a new create and shutdown both proceed',
    async (_how, cause) => {
      acquire.mockImplementationOnce(async ({ events }) => {
        // The published child's exit reached the translator before any journal was attached.
        events?.setActivity?.(null)
        throw cause
      })

      const failed = host.attach(CALLER, hostTestAttachParams(null))
      await (cause instanceof AgentSessionPreSpawnError
        ? expect(failed).rejects.toThrow(EXIT_REASON)
        : expect(failed).resolves.toMatchObject({ ok: false, refusal: { message: EXIT_REASON } }))

      await expect(host.attach(CALLER, hostTestAttachParams(null))).resolves.toMatchObject({
        ok: true
      })
      await expect(host.flushAllStreamedEvents()).resolves.toBeUndefined()
      expect(acquire).toHaveBeenCalledTimes(2)
    }
  )

  it.each([
    ['refused', new Error(EXIT_REASON)],
    ['thrown', new AgentSessionPreSpawnError(new Error(EXIT_REASON))]
  ])('releases the sink when a resume of a still-indexed session is %s', async (_how, cause) => {
    await expect(host.attach(CALLER, hostTestAttachParams(null))).resolves.toMatchObject({
      ok: true
    })
    const exitedFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      reason: 'provider exited',
      cause: 'unexpected-exit',
      fence: exitedFence,
      acquisitionGeneration: `generation-${exitedFence}`
    })
    const releasedFence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    acquire.mockImplementationOnce(async ({ events }) => {
      events?.setActivity?.(null)
      throw cause
    })

    // The session stays indexed across this failure: it is a resume, not a create.
    const failed = host.attach(CALLER, hostTestAttachParams(releasedFence))
    await (cause instanceof AgentSessionPreSpawnError
      ? expect(failed).rejects.toThrow(EXIT_REASON)
      : expect(failed).resolves.toMatchObject({ ok: false }))

    const fence = store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    await expect(host.attach(CALLER, hostTestAttachParams(fence))).resolves.toMatchObject({
      ok: true
    })
    expect(acquire).toHaveBeenCalledTimes(3)
    // Only the adopted child's sink still takes writes: the failed attempt's closed with it, and
    // the exited generation's closed when the resume replaced it.
    const [exited, failedAttempt, resumed] = acquire.mock.calls.map(([input]) => input.events)
    expect(failedAttempt?.tryPublish?.()).toEqual({ accepted: false, reason: 'closed' })
    expect(exited?.tryPublish?.()).toEqual({ accepted: false, reason: 'closed' })
    expect(resumed?.tryPublish?.()).toEqual({ accepted: true })
    await expect(host.flushAllStreamedEvents()).resolves.toBeUndefined()
  })
})
