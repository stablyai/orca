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
  journal: null as AgentSessionJournal | null
}))

// The lease reservation, the record store and the provider child are not what
// these cases are about; `onAttached` is, and it is the real one.
vi.mock('./structured-agent-session-attach-flow', () => ({
  performAttach: async (input: {
    onAttached: (
      attached: { journal: AgentSessionJournal; recovery: null },
      generation: string | null
    ) => Promise<void>
  }) => {
    await input.onAttached({ journal: attachFlow.journal!, recovery: null }, null)
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
  sessions: Map<string, StructuredAgentSessionHostSession>
): StructuredAgentSessionAttachContext {
  const eventSink = {
    sink: {},
    drained: async () => ({ ok: true }) as const,
    unbind: () => undefined,
    bind: () => undefined,
    close: () => undefined
  }
  return {
    deps: { store: { getRecord: () => null }, claimKeyId: 'key-1', journalRoot: root },
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
      publish: () => undefined
    },
    tasks: { trackAttach: <T>(task: Promise<T>) => task },
    reconcileLeases: async () => null,
    serialize: <T>(_sessionId: string, task: () => Promise<T>) => task(),
    now: () => 1
  } as unknown as StructuredAgentSessionAttachContext
}

const attachParams = {
  envelope: { sessionId: SESSION, clientOperationId: 'op-1' }
} as unknown as Parameters<typeof attachStructuredAgentSession>[2]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-close-retry-'))
  // The registry is process-wide; drain it so one case cannot see another's.
  await agentSessionJournalCloseRetries.retryAll()
})

afterEach(async () => {
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
