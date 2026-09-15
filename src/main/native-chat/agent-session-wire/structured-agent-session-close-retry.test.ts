// A close that REJECTED did not release the handle.
//
// `AgentSessionJournal.close()` is retryable by design: the release step is
// unguarded precisely so a second call is a second attempt. Callers that did
// `close().catch(() => undefined)` and then threw or overwrote their map entry
// turned that retryable failure into a permanent orphan — on POSIX a silent
// leak, on Windows a handle that blocks renaming or removing the directory.
//
// These drive the REAL callers: the attach orchestration's `onAttached`, and
// host teardown, which is what runtime stop calls. Only the lease/record
// machinery around them is stubbed.

import { access, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import {
  agentSessionJournalCloseRetries,
  JournalCloseRetryRegistry
} from '../agent-session-journal/journal-close-retry'
import { journalDatabaseFile } from '../agent-session-journal/journal-paths'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { attachStructuredAgentSession } from './structured-agent-session-attach-orchestration'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { tearDownStructuredAgentSessionHost } from './structured-agent-session-host-teardown'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

const attachFlow = vi.hoisted(() => ({
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: vi.hoisted cannot infer the journal type before the test initializes it.
  journal: null as AgentSessionJournal | null,
  acquiredOwner: false
}))

// The lease reservation, the record store and the provider child are not what
// these cases are about; `onAttached` is, and it is the real one.
vi.mock('./structured-agent-session-attach-flow', () => ({
  performAttach: async (input: {
    onAttached: (
      attached: {
        journal: AgentSessionJournal
        recovery: null
        unconfirmedClientMessageIds?: string[]
      },
      generation: string | null,
      acquiredOwner: boolean
    ) => Promise<void>
  }) => {
    await input.onAttached(
      { journal: attachFlow.journal!, recovery: null, unconfirmedClientMessageIds: [] },
      null,
      attachFlow.acquiredOwner
    )
    return { ok: true, value: {} }
  }
}))

const SESSION = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: SESSION,
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: SESSION }
}

let root: string
const journals = createTrackedJournalOpener()

async function exists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false)
}

async function expectNothingHoldsTheDirectory(directory: string): Promise<void> {
  const dbPath = journalDatabaseFile(directory)
  expect(await exists(`${dbPath}-wal`)).toBe(false)
  expect(await exists(`${dbPath}-shm`)).toBe(false)
  // The half that actually fails on Windows when a handle is still open.
  const moved = `${directory}-moved`
  await rename(directory, moved)
  await rm(moved, { recursive: true })
}

function hostSession(journal: AgentSessionJournal): StructuredAgentSessionHostSession {
  return {
    journal,
    params: {} as StructuredAgentSessionHostSession['params'],
    fence: 1,
    hasProviderChild: false,
    acquisitionGeneration: null
  }
}

/** A journal whose close rejects until `failures` is exhausted, wrapping a real
 *  store so the handle it holds is a real one. */
function flakyClose(journal: AgentSessionJournal, failures: number): AgentSessionJournal {
  let remaining = failures
  return new Proxy(journal, {
    get(target, property, receiver) {
      if (property !== 'close') {
        // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: only Reflect.get forwards a raw string|symbol key with the proxy receiver.
        return Reflect.get(target, property, receiver)
      }
      return async () => {
        if (remaining > 0) {
          remaining -= 1
          throw new Error('close rejected')
        }
        await target.close()
      }
    }
  })
}

function attachContext(
  sessions: Map<string, StructuredAgentSessionHostSession>,
  record: unknown = null,
  publish: () => void = () => undefined
): StructuredAgentSessionAttachContext {
  let currentRecord = record
  const eventSink = {
    sink: {},
    drained: async () => ({ ok: true }) as const,
    unbind: () => undefined,
    bind: () => undefined,
    close: () => undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture intentionally supplies only the attach dependencies exercised by these orchestration tests.
  return {
    deps: {
      store: {
        getRecord: () => currentRecord,
        transitionHandoff: async (_sessionId: string, transition: (record: never) => never) => {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fake store forwards the real transition callback without modeling its durable record type.
          currentRecord = transition(currentRecord as never)
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fake store returns the test record through the production callback boundary.
          return currentRecord as never
        }
      },
      claimKeyId: 'key-1',
      journalRoot: root
    },
    runtimeState: {
      resolveRecovery: async () => undefined,
      eventSinkFor: () => eventSink,
      probeOwner: async () => ({ outcome: 'pid-absent' }),
      discardEventSink: () => undefined
    },
    sessions,
    subscribers: {
      reset: () => undefined,
      snapshot: () => undefined,
      publish
    },
    tasks: { trackAttach: <T>(task: Promise<T>) => task },
    reconcileLeases: async () => null,
    serialize: <T>(_sessionId: string, task: () => Promise<T>) => task(),
    now: () => 1,
    forgetStatus: () => undefined
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture intentionally supplies only the attach dependencies exercised by these orchestration tests.
  } as unknown as StructuredAgentSessionAttachContext
}

const attachParams = {
  envelope: { sessionId: SESSION, clientOperationId: 'op-1' }
} as unknown as Parameters<typeof attachStructuredAgentSession>[2]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-close-retry-'))
  attachFlow.acquiredOwner = false
  // The registry is process-wide; drain it so one case cannot see another's.
  await agentSessionJournalCloseRetries.retryAll()
})

afterEach(async () => {
  attachFlow.acquiredOwner = false
  await agentSessionJournalCloseRetries.retryAll()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('the registry', () => {
  it('retains a journal whose close rejected and releases it on the retry', async () => {
    const directory = join(root, 'retained')
    const registry = new JournalCloseRetryRegistry()
    const journal = flakyClose(
      await journals.open({ identity: IDENTITY, journalDir: directory }),
      1
    )

    const first = await registry.closeOrRetain(journal)
    expect(first.closed).toBe(false)
    expect(registry.pendingDirectories).toEqual([directory])

    expect(await registry.retryAll()).toEqual([])
    expect(registry.pendingDirectories).toEqual([])
    await expectNothingHoldsTheDirectory(directory)
  })
})

describe('the attach orchestration', () => {
  it('does not hold attach on a dead-generation settlement that never settles', async () => {
    const directory = join(root, 'settlement-stall')
    const journal = await journals.open({ identity: IDENTITY, journalDir: directory })
    await journal.appendItem(
      { provider: 'codex', threadId: SESSION, turnId: 'turn-1', ordinal: 0 },
      { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: 1 },
      { fence: 0 }
    )
    let releaseSettlement!: () => void
    vi.spyOn(journal, 'markPendingSubmissionsUnknown').mockReturnValue(
      new Promise<string[]>((resolve) => {
        releaseSettlement = () => resolve([])
      })
    )
    attachFlow.journal = journal
    attachFlow.acquiredOwner = true
    const sessions = new Map<string, StructuredAgentSessionHostSession>()
    const attach = attachStructuredAgentSession(
      attachContext(sessions, { lease: { runtimeFence: 1 } }),
      'caller-1',
      attachParams
    )

    await expect(
      Promise.race([
        attach.then(() => 'attached' as const),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 100))
      ])
    ).resolves.toBe('attached')
    expect(sessions.has(SESSION)).toBe(true)

    releaseSettlement()
    await attach
  })

  it('persists a retry latch when detached settlement fails without a prior latch', async () => {
    const directory = join(root, 'settlement-latch')
    const journal = await journals.open({ identity: IDENTITY, journalDir: directory })
    await journal.appendItem(
      { provider: 'codex', threadId: SESSION, turnId: 'turn-1', ordinal: 0 },
      { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: 1 },
      { fence: 0 }
    )
    vi.spyOn(journal, 'appendLifecycleBatch').mockRejectedValue(new Error('journal unavailable'))
    attachFlow.journal = journal
    attachFlow.acquiredOwner = true
    const record = {
      lease: {
        runtimeFence: 1,
        claimStatus: 'live',
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This optional lease field is explicitly absent in the fixture's initial state.
        settlementRetryRequired: undefined as boolean | undefined,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This optional lease field is explicitly absent in the fixture's initial state.
        settlementRetryFence: undefined as number | undefined,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This optional lease field is explicitly absent in the fixture's initial state.
        settlementRetryId: undefined as string | undefined,
        deathEvidence: null
      }
    }
    const sessions = new Map<string, StructuredAgentSessionHostSession>()
    const context = attachContext(sessions, record)
    const attach = attachStructuredAgentSession(context, 'caller-1', attachParams)

    await attach
    await vi.waitFor(() =>
      expect(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fake store returns the local fixture shape.
        (context.deps.store.getRecord(SESSION) as typeof record).lease.settlementRetryRequired
      ).toBe(true)
    )
    expect(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fake store returns the local fixture shape.
      (context.deps.store.getRecord(SESSION) as typeof record).lease.settlementRetryFence
    ).toBe(0)
  })

  it('publishes detached settlement rows after the new owner is attached', async () => {
    const directory = join(root, 'settlement-publish')
    const journal = await journals.open({ identity: IDENTITY, journalDir: directory })
    await journal.appendItem(
      { provider: 'codex', threadId: SESSION, turnId: 'turn-1', ordinal: 0 },
      { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: 1 },
      { fence: 0 }
    )
    attachFlow.journal = journal
    attachFlow.acquiredOwner = true
    const publish = vi.fn()
    const context = attachContext(
      new Map<string, StructuredAgentSessionHostSession>(),
      {
        lease: {
          runtimeFence: 1,
          claimStatus: 'live',
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This optional lease field is explicitly absent in the fixture's initial state.
          settlementRetryRequired: undefined as boolean | undefined,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This optional lease field is explicitly absent in the fixture's initial state.
          settlementRetryFence: undefined as number | undefined,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This optional lease field is explicitly absent in the fixture's initial state.
          settlementRetryId: undefined as string | undefined,
          deathEvidence: { kind: 'exit-observed', detail: 'provider stopped', observedAt: 2 }
        }
      },
      publish
    )

    await attachStructuredAgentSession(context, 'caller-1', attachParams)
    await vi.waitFor(() => expect(publish.mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(journal.snapshot().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ body: expect.objectContaining({ state: 'interrupted' }) })
      ])
    )
  })

  it('ABORTS the map replacement when the previous journal will not close', async () => {
    const previousDir = join(root, 'previous')
    const provisionalDir = join(root, 'provisional')
    const previous = flakyClose(
      await journals.open({ identity: IDENTITY, journalDir: previousDir }),
      1
    )
    const provisional = await journals.open({
      identity: IDENTITY,
      journalDir: provisionalDir
    })
    attachFlow.journal = provisional
    const sessions = new Map([[SESSION, hostSession(previous)]])

    await expect(
      attachStructuredAgentSession(attachContext(sessions), 'caller-1', attachParams)
    ).rejects.toThrow('close rejected')

    // The live entry is UNTOUCHED: overwriting it would have left its handle
    // open with nothing able to reach it again.
    expect(sessions.get(SESSION)?.journal).toBe(previous)
    // And the provisional journal is owned by the registry, not orphaned.
    expect(agentSessionJournalCloseRetries.pendingDirectories).toEqual([])
    await expectNothingHoldsTheDirectory(provisionalDir)
  })

  it('retains the provisional journal when its own close rejects on the barrier path', async () => {
    const provisionalDir = join(root, 'provisional-barrier')
    const provisional = flakyClose(
      await journals.open({ identity: IDENTITY, journalDir: provisionalDir }),
      1
    )
    attachFlow.journal = provisional
    const sessions = new Map<string, StructuredAgentSessionHostSession>()
    const context = attachContext(sessions)
    const failing = {
      sink: {},
      drained: async () => ({ ok: false, error: new Error('sink barrier failed') }) as const,
      unbind: () => undefined,
      bind: () => undefined,
      close: () => undefined
    }
    context.runtimeState.eventSinkFor = (() =>
      failing) as unknown as typeof context.runtimeState.eventSinkFor

    await expect(attachStructuredAgentSession(context, 'caller-1', attachParams)).rejects.toThrow(
      'sink barrier failed'
    )

    expect(sessions.size).toBe(0)
    // Retained rather than dropped, so teardown can still release the handle.
    expect(agentSessionJournalCloseRetries.pendingDirectories).toEqual([provisionalDir])
  })
})

describe('teardown, which is what runtime stop calls', () => {
  it('retries the journals earlier failure paths could not close', async () => {
    const orphanDir = join(root, 'orphan')
    const orphan = flakyClose(await journals.open({ identity: IDENTITY, journalDir: orphanDir }), 1)
    expect((await agentSessionJournalCloseRetries.closeOrRetain(orphan)).closed).toBe(false)

    // The first teardown reports the still-failing close instead of hiding it.
    await tearDownStructuredAgentSessionHost({ phases: [], sessions: new Map() })

    expect(agentSessionJournalCloseRetries.pendingDirectories).toEqual([])
    await expectNothingHoldsTheDirectory(orphanDir)
  })

  it('surfaces a retained close that still rejects, and keeps it for the next stop', async () => {
    const orphanDir = join(root, 'stubborn')
    const orphan = flakyClose(await journals.open({ identity: IDENTITY, journalDir: orphanDir }), 2)
    await agentSessionJournalCloseRetries.closeOrRetain(orphan)

    await expect(
      tearDownStructuredAgentSessionHost({ phases: [], sessions: new Map() })
    ).rejects.toMatchObject({ errors: [expect.objectContaining({ message: 'close rejected' })] })
    expect(agentSessionJournalCloseRetries.pendingDirectories).toEqual([orphanDir])

    // A later stop is a real retry, not a no-op.
    await tearDownStructuredAgentSessionHost({ phases: [], sessions: new Map() })
    expect(agentSessionJournalCloseRetries.pendingDirectories).toEqual([])
    await expectNothingHoldsTheDirectory(orphanDir)
  })
})
