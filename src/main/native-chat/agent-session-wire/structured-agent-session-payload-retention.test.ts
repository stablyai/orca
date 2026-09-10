// The shipping path retains what it clips.
//
// The unit suite for the overflow store proves the store works. This proves it
// is WIRED: a real Codex translator, over a real deferred event sink, bound to a
// real journal on disk. Severing only `payloadLimits()` — the single production
// wire — must turn every assertion here red, because that is exactly the state
// STA-6924 shipped in.
//
// The unbind case is not incidental. A payload is bounded when its frame is
// handled but journaled when the queue drains, and a native handoff unbinds the
// sink across the whole `acquire` while the provider child is already emitting.

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from '../../codex/codex-structured-session-adapter'
import {
  journalOverflowDirectory,
  readJournalOverflow
} from '../agent-session-journal/journal-overflow-store'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import type { DeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-retention',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-abc' }
}

const SESSION_ID = 'session-retention'
const THREAD_ID = 'thread-abc'
/** Comfortably past the 16 KiB inline head, and unique per test run so a digest
 *  can never collide with something an earlier case retained. */
const OVERSIZED_OUTPUT = `${'tool output line\n'.repeat(4_000)}${Math.random()}`

let journalRoot: string
let journalDir: string
let journal: AgentSessionJournal
let eventSink: DeferredStructuredAgentSessionEventSink
const journals = createTrackedJournalOpener()

/** Only what `eventSinkFor` reads to locate the session's journal directory. */
function hostDeps(): StructuredAgentSessionHostDeps {
  return {
    journalRoot,
    store: {
      getRecord: () => ({ location: { workspaceId: IDENTITY.workspaceId } })
    }
  } as unknown as StructuredAgentSessionHostDeps
}

function notification(method: string, params: unknown): CodexStructuredSessionEvent {
  return { type: 'notification', sessionId: SESSION_ID, threadId: THREAD_ID, method, params }
}

/** A completed shell call carrying an oversized result — the exact shape
 *  STA-6924 names as irreversibly lost. */
function completedCommand(output: string): CodexStructuredSessionEvent {
  return notification('item/completed', {
    item: {
      type: 'commandExecution',
      id: 'exec-1',
      command: 'cat big-file',
      status: 'completed',
      exitCode: 0,
      aggregatedOutput: output
    }
  })
}

function bind(): void {
  eventSink.bind({
    journal,
    fence: 1,
    publish: () => undefined
  })
}

/** The bounded tool output the journal actually persisted. */
function journaledToolOutput(): Extract<AgentJournalItemBody, { kind: 'tool-call' }>['output'] {
  const item = journal
    .snapshot()
    .items.map((entry) => entry.body)
    .find((body) => body.kind === 'tool-call')
  expect(item, 'no tool-call row reached the journal').toBeDefined()
  return item?.kind === 'tool-call' ? item.output : undefined
}

beforeEach(async () => {
  journalRoot = await mkdtemp(join(tmpdir(), 'orca-retention-'))
  journalDir = journalDirectoryFor(journalRoot, IDENTITY)
  journal = await journals.open({ identity: IDENTITY, journalDir })
  // Through the host, so the production wiring is what is under test — not a
  // sink this file assembled the way it wishes production did.
  eventSink = new StructuredAgentSessionHostRuntimeState(hostDeps()).eventSinkFor(SESSION_ID)
})

afterEach(async () => {
  eventSink.close()
  await journals.closeAll()
  await rm(journalRoot, { recursive: true, force: true })
})

it('retains an oversized tool result reachable by the digest on its journal row', async () => {
  bind()
  const translator = createCodexJournalTranslator({ sink: eventSink.sink })
  translator.handle(notification('turn/started', { turn: { id: 'turn-1' } }))
  translator.handle(completedCommand(OVERSIZED_OUTPUT))
  translator.flush()
  expect(await eventSink.drained()).toMatchObject({ ok: true })

  const output = journaledToolOutput()
  expect(output).toMatchObject({ truncated: true, spilled: true })
  expect(output?.byteLength).toBe(Buffer.byteLength(OVERSIZED_OUTPUT, 'utf8'))
  // The row is the only pointer to the bytes, so the digest on it has to resolve.
  expect(readJournalOverflow(journalDir, output?.digest ?? '')).toBe(OVERSIZED_OUTPUT)
})

it('still retains a payload whose frame arrives while the sink is unbound', async () => {
  // The native-handoff window: bound, then unbound across `acquire` while the
  // provider child keeps emitting, then rebound.
  bind()
  eventSink.unbind()
  const translator = createCodexJournalTranslator({ sink: eventSink.sink })
  translator.handle(notification('turn/started', { turn: { id: 'turn-1' } }))
  translator.handle(completedCommand(OVERSIZED_OUTPUT))
  translator.flush()
  bind()
  expect(await eventSink.drained()).toMatchObject({ ok: true })

  const output = journaledToolOutput()
  expect(output).toMatchObject({ truncated: true, spilled: true })
  expect(readJournalOverflow(journalDir, output?.digest ?? '')).toBe(OVERSIZED_OUTPUT)
})

it('retains a payload whose frame arrives before the sink is ever bound', async () => {
  // A fresh attach acquires the provider child before it binds the sink.
  const translator = createCodexJournalTranslator({ sink: eventSink.sink })
  translator.handle(notification('turn/started', { turn: { id: 'turn-1' } }))
  translator.handle(completedCommand(OVERSIZED_OUTPUT))
  translator.flush()
  bind()
  expect(await eventSink.drained()).toMatchObject({ ok: true })

  const output = journaledToolOutput()
  expect(output).toMatchObject({ truncated: true, spilled: true })
  expect(readJournalOverflow(journalDir, output?.digest ?? '')).toBe(OVERSIZED_OUTPUT)
})

it('does not retain in-flight stream checkpoints, only the completed item', async () => {
  // A growing payload hashes differently at every checkpoint, so retaining each
  // one would write the sum of all prefixes. The completed row below is the only
  // one that has to hold bytes, and it holds the whole of them.
  bind()
  const translator = createCodexJournalTranslator({ sink: eventSink.sink })
  translator.handle(notification('turn/started', { turn: { id: 'turn-1' } }))
  translator.handle(
    notification('item/started', {
      item: {
        type: 'commandExecution',
        id: 'exec-1',
        command: 'cat big-file',
        status: 'inProgress'
      }
    })
  )
  for (let checkpoint = 0; checkpoint < 4; checkpoint += 1) {
    translator.handle(
      notification('item/commandExecution/outputDelta', {
        itemId: 'exec-1',
        delta: OVERSIZED_OUTPUT.slice(checkpoint * 20_000, (checkpoint + 1) * 20_000)
      })
    )
    translator.flush()
  }
  translator.handle(completedCommand(OVERSIZED_OUTPUT))
  translator.flush()
  expect(await eventSink.drained()).toMatchObject({ ok: true })

  const output = journaledToolOutput()
  expect(output).toMatchObject({ truncated: true, spilled: true })
  expect(readJournalOverflow(journalDir, output?.digest ?? '')).toBe(OVERSIZED_OUTPUT)
  // One payload on disk, not one per checkpoint.
  expect(await readdir(journalOverflowDirectory(journalDir))).toHaveLength(1)
})
