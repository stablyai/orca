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
    child: null
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
  sessions: Map<string, StructuredAgentSessionHostSession>
): StructuredAgentSessionAttachContext {
  const eventSink = {
    sink: {},
    drained: async () => ({ ok: true }) as const,
    unbind: () => undefined,
    bind: () => undefined,
    close: () => undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial context double; the attach reads only the members defined here.
  return {
    deps: { store: { getRecord: () => null }, claimKeyId: 'key-1', journalRoot: root },
    runtimeState: {
      resolveRecovery: async () => undefined,
      eventSinkFor: () => eventSink,
      currentEventSink: () => eventSink,
      mintEventSink: () => eventSink,
      adoptEventSink: () => undefined,
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
    now: () => 1,
    publishStatus: () => undefined
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
  // The attach adopts the conversation's one open journal; it never opens a second handle, so
  // there is no replacement to abort and no provisional journal to close.
  it('keeps the journal it adopted indexed and open when an attach succeeds', async () => {
    const directory = join(root, 'adopted')
    const journal = await journals.open({ identity: IDENTITY, journalDir: directory })
    attachFlow.journal = journal
    const sessions = new Map([[SESSION, hostSession(journal)]])

    await attachStructuredAgentSession(attachContext(sessions), 'caller-1', attachParams)

    expect(sessions.get(SESSION)?.journal).toBe(journal)
    await expect(
      journal.appendItem(
        { provider: 'orca', clientMessageId: 'after-attach' },
        {
          kind: 'status',
          text: 'still writable'
        }
      )
    ).resolves.toBeDefined()
    expect(agentSessionJournalCloseRetries.pendingDirectories).toEqual([])
  })

  it('leaves the conversation indexed and open when the sink barrier fails', async () => {
    const directory = join(root, 'adopted-barrier')
    const journal = await journals.open({ identity: IDENTITY, journalDir: directory })
    attachFlow.journal = journal
    const sessions = new Map([[SESSION, hostSession(journal)]])
    const context = attachContext(sessions)
    const failing = {
      sink: {},
      drained: async () => ({ ok: false, error: new Error('sink barrier failed') }) as const,
      unbind: () => undefined,
      bind: () => undefined,
      close: () => undefined
    }
    // The re-attach binds the sink the live child already writes through.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial sink double; the attach reads only drained/bind/close from it.
    context.runtimeState.currentEventSink = (() =>
      failing) as unknown as typeof context.runtimeState.currentEventSink

    await expect(attachStructuredAgentSession(context, 'caller-1', attachParams)).rejects.toThrow(
      'sink barrier failed'
    )

    // A failed attach does not end the conversation: its queued messages and the failure row
    // are written into this same journal.
    expect(sessions.get(SESSION)?.journal).toBe(journal)
    await expect(
      journal.appendItem(
        { provider: 'orca', clientMessageId: 'after-failure' },
        {
          kind: 'status',
          text: 'still writable'
        }
      )
    ).resolves.toBeDefined()
    expect(agentSessionJournalCloseRetries.pendingDirectories).toEqual([])
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
