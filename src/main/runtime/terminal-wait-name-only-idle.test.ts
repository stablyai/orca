import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalIdlePolls } from './runtime-terminal-idle-polls'
import { RuntimeTerminalWait } from './runtime-terminal-wait'
import { RuntimeTerminalWaiterRegistry } from './runtime-terminal-waiter-registry'
import {
  errorMessage,
  makeTuiIdleLeaf,
  makeTuiIdlePty,
  makeTuiIdleRuntime
} from './tui-idle-wait-test-harness'
import type { RuntimeSyncWindowGraph } from '../../shared/runtime-types'
import type { AgentStatus } from '../../shared/agent-detection'
import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { RuntimeScreenCapture } from './orca-runtime-core'
import {
  captureTuiIdleEvidenceCursor,
  observeTuiIdle,
  type FirstPartyAgentStatus,
  type TuiIdleEvidenceRecord
} from './tui-idle-evidence'

// #6011: `terminal wait --for tui-idle` returned satisfied in ~0s against a working agent,
// because a Codex/Devin OSC title that carries only the agent NAME is stored as `idle` and
// the wait accepted the stored value. These tests pin which attachment-bound evidence settles
// the wait, which remains unknown, and which vetoes.

const POLL_INTERVAL_MS = 2000
const OUTPUT_AGE_FIXTURE_MS = 3000
const NAME_ONLY_TITLE = 'Codex'
const EXPLICIT_IDLE_TITLE = 'Codex ready'
const HANDLE = 'terminal-1'

function createWait(options: {
  pty?: RuntimePtyWorktreeRecord
  leaf?: RuntimeLeafRecord
  adoptedIdleStatus?: AgentStatus | null
  adoptedTitle?: string | null
  tabTitle?: string | null
  foreground?: string | null
  agent?: TuiAgent | null
  firstPartyStatus?: FirstPartyAgentStatus
  liveLeaf?: () => RuntimeLeafRecord
  screenCapture?: RuntimeScreenCapture | null
}) {
  const waiters = new RuntimeTerminalWaiterRegistry()
  const startVisibleReadProbe = vi.fn()
  const shared = {
    getTabTitle: () => options.tabTitle ?? null,
    getAdoptedPtyIdleStatus: () => options.adoptedIdleStatus ?? null,
    getAdoptedPtyTitle: () => options.adoptedTitle ?? null,
    getPaneAgent: () => options.agent ?? null,
    getFirstPartyAgentStatus: () => options.firstPartyStatus ?? null,
    getAttachmentId: () => 'test-incarnation',
    getScreenCapture: () => options.screenCapture ?? null,
    getTerminalProcessIncarnation: () => 'test-incarnation'
  }
  const polls = new RuntimeTerminalIdlePolls({
    ...shared,
    intervalMs: POLL_INTERVAL_MS,
    getLiveLeaf: (leaf) => options.liveLeaf?.() ?? leaf,
    resolve: (waiter, result) => waiters.resolve(waiter, result)
  })
  const wait = new RuntimeTerminalWait(
    {
      ...shared,
      defaultTimeoutMs: 60_000,
      getLivePty: () => (options.pty ? { pty: options.pty } : null),
      getLiveLeaf: () => ({ leaf: options.leaf ?? makeTuiIdleLeaf() }),
      startVisibleReadProbe
    },
    waiters,
    polls
  )
  return { wait, waiters, polls, startVisibleReadProbe }
}

function watch(promise: Promise<unknown>) {
  const settled = vi.fn()
  void promise.then(
    (value) => settled({ ok: value }),
    (error) => settled({ error: errorMessage(error) })
  )
  return settled
}

/** Keeps the record "streaming": each poll sees a fresh output timestamp. */
async function advanceWhileStreaming(
  record: { lastOutputAt: number | null },
  ticks: number
): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) {
    record.lastOutputAt = Date.now()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
  }
}

describe('tui-idle evidence ranking', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('refuses a stored name-only idle while the pane is still streaming', async () => {
    const pty = makeTuiIdlePty({ lastAgentStatus: 'idle', lastOscTitle: NAME_ONLY_TITLE })
    const { wait } = createWait({ pty, agent: 'codex' })
    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 }))

    await advanceWhileStreaming(pty, 4)
    expect(settled).not.toHaveBeenCalled()
  })

  it('remains unknown after a name-only pane has been quiet for the window', async () => {
    const pty = makeTuiIdlePty({ lastAgentStatus: 'idle', lastOscTitle: NAME_ONLY_TITLE })
    const { wait } = createWait({ pty, agent: 'codex' })
    const result = wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 10_000 })

    await advanceWhileStreaming(pty, 2)
    // Still inside the timeout while output is arriving.
    await vi.advanceTimersByTimeAsync(6_000)
    await expect(result).resolves.toMatchObject({
      satisfied: false,
      readiness: { state: 'unknown' }
    })
  })

  it('settles an explicit idle title after a new observation, without an elapsed-silence delay', async () => {
    const pty = makeTuiIdlePty({ lastAgentStatus: 'idle', lastOscTitle: NAME_ONLY_TITLE })
    const { wait } = createWait({ pty, agent: 'codex' })
    const result = wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 })
    pty.lastOscTitle = EXPLICIT_IDLE_TITLE
    pty.lastOscTitleAt = 2
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    await expect(result).resolves.toMatchObject({ satisfied: true })
  })

  it('reports an explicit provider working title as busy instead of unknown', async () => {
    const pty = makeTuiIdlePty({ lastAgentStatus: 'working', lastOscTitle: '⠋ Codex' })
    const { wait } = createWait({ pty, agent: 'codex' })
    const result = wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 100 })

    await vi.advanceTimersByTimeAsync(100)
    await expect(result).resolves.toMatchObject({
      satisfied: false,
      readiness: { state: 'busy', source: 'title', agent: 'codex' }
    })
  })

  it('accepts a provider-specific ready screen when launch metadata is absent', async () => {
    const pty = makeTuiIdlePty()
    const screenCapture: RuntimeScreenCapture = {
      attachmentId: 'test-incarnation',
      generation: 1,
      outputSequence: 1,
      revision: 1,
      source: 'headless'
    }
    const { wait } = createWait({
      pty,
      agent: null,
      screenCapture
    })
    const result = wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 })
    pty.preview = 'OpenAI Codex\nModel: gpt-5\nDirectory: /tmp/repo'
    screenCapture.revision = 2
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    await expect(result).resolves.toMatchObject({
      satisfied: true,
      readiness: { state: 'ready', source: 'screen', agent: 'codex' }
    })
  })

  it('accepts an adopted provider title when PTY launch metadata is absent', async () => {
    const pty = makeTuiIdlePty({ lastAgentStatus: 'idle', lastOscTitleEpochMs: null })
    const { wait } = createWait({
      pty,
      agent: null,
      adoptedIdleStatus: 'idle',
      adoptedTitle: 'OMP ready'
    })
    const result = wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 })
    pty.lastOscTitleAt = 2
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    await expect(result).resolves.toMatchObject({
      satisfied: true,
      readiness: { state: 'ready', source: 'title', agent: 'omp' }
    })
  })

  it('does not attach a ready screen from a different provider to the launch', async () => {
    const pty = makeTuiIdlePty({
      preview: 'OpenAI Codex\nModel: gpt-5\nDirectory: /tmp/repo'
    })
    const { wait } = createWait({ pty, agent: 'claude' })
    const result = wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    await expect(result).resolves.toMatchObject({
      satisfied: false,
      readiness: { state: 'unknown', agent: 'claude' }
    })
  })

  // Why this case exists: daemon-hosted panes may have no renderer title, but their retained
  // attachment record still carries an explicit provider marker.
  it('reads an explicit idle title off the record when no renderer published one', async () => {
    const leaf = makeTuiIdleLeaf({
      lastAgentStatus: 'idle',
      lastOscTitle: EXPLICIT_IDLE_TITLE,
      paneTitle: null
    })
    const { wait } = createWait({ leaf, agent: 'codex', tabTitle: null })
    const result = wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 })
    leaf.lastOscTitleAt = 2
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    await expect(result).resolves.toMatchObject({ satisfied: true })
  })

  it('lets the agent own status stream veto an otherwise-quiet name-only idle', async () => {
    const pty = makeTuiIdlePty({
      lastAgentStatus: 'idle',
      lastOscTitle: NAME_ONLY_TITLE,
      lastOutputAt: Date.now() - OUTPUT_AGE_FIXTURE_MS * 4
    })
    const { wait } = createWait({
      pty,
      agent: 'codex',
      firstPartyStatus: { state: 'working', updatedAt: Date.now() }
    })
    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 }))
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    expect(settled).not.toHaveBeenCalled()
  })

  it('returns unknown for an agent that never emits anything but its name', async () => {
    const pty = makeTuiIdlePty({ lastAgentStatus: 'idle', lastOscTitle: 'grok' })
    const { wait } = createWait({ pty, agent: 'grok' })
    const result = wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    await expect(result).resolves.toMatchObject({
      satisfied: false,
      readiness: { state: 'unsupported' }
    })
  })

  it('falls back to the title when the pane carries no launch metadata', async () => {
    const pty = makeTuiIdlePty({ lastAgentStatus: 'idle', lastOscTitle: NAME_ONLY_TITLE })
    const { wait } = createWait({ pty, agent: null })
    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 }))
    await advanceWhileStreaming(pty, 3)
    expect(settled).not.toHaveBeenCalled()
  })

  // Why: `syncWindowGraph` rebuilds leaf records, so a poll must re-read the live attachment
  // rather than a stale object from waiter registration.
  it('tracks the live leaf record across a graph sync instead of a frozen capture', async () => {
    const registered = makeTuiIdleLeaf({ lastAgentStatus: 'idle', lastOscTitle: NAME_ONLY_TITLE })
    let live = registered
    const { wait } = createWait({ leaf: registered, agent: 'codex', liveLeaf: () => live })
    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 }))

    // The renderer republishes: a brand-new object replaces the captured one.
    live = makeTuiIdleLeaf({ lastAgentStatus: 'idle', lastOscTitle: NAME_ONLY_TITLE })
    registered.lastOutputAt = Date.now() - OUTPUT_AGE_FIXTURE_MS * 10
    await advanceWhileStreaming(live, 4)
    expect(settled).not.toHaveBeenCalled()
  })

  it('never settles tui-idle on a permission status', async () => {
    const pty = makeTuiIdlePty({
      lastAgentStatus: 'permission',
      lastOscTitle: 'Codex - action required'
    })
    const { wait } = createWait({ pty, agent: 'codex' })
    const settled = watch(wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 60_000 }))
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4 + OUTPUT_AGE_FIXTURE_MS)
    expect(settled).not.toHaveBeenCalled()
  })

  it('does not promote retained title or screen evidence after first-party work ages out', () => {
    const now = Date.now()
    const record: TuiIdleEvidenceRecord = {
      lastAgentStatus: 'idle',
      lastOscTitle: EXPLICIT_IDLE_TITLE,
      lastOscTitleObservedAt: now - 31 * 60 * 1000,
      lastOutputAt: now - 31 * 60 * 1000,
      attachmentId: 'inc-1'
    }
    expect(
      observeTuiIdle({
        record,
        agent: 'codex',
        firstPartyStatus: {
          state: 'working',
          updatedAt: now - 31 * 60 * 1000,
          attachmentId: 'inc-1'
        },
        readPositiveBodyEvidence: () => true,
        positiveBodyEvidenceAgent: 'codex'
      })
    ).toMatchObject({ state: 'unknown', source: 'first-party', agent: 'codex' })
  })

  it('accepts a same-attachment title observation newer than the stale first-party fact', () => {
    const now = Date.now()
    expect(
      observeTuiIdle({
        record: {
          lastAgentStatus: 'idle',
          lastOscTitle: EXPLICIT_IDLE_TITLE,
          lastOscTitleAt: 1,
          lastOscTitleObservedAt: now,
          lastOutputAt: now,
          attachmentId: 'inc-1'
        },
        agent: 'codex',
        firstPartyStatus: {
          state: 'working',
          updatedAt: now - 31 * 60 * 1000,
          attachmentId: 'inc-1'
        },
        readPositiveBodyEvidence: () => false
      })
    ).toMatchObject({ state: 'ready', source: 'title', agent: 'codex' })
  })

  it('requires a new title or screen observation for each readiness operation', () => {
    const now = Date.now()
    const record: TuiIdleEvidenceRecord = {
      lastAgentStatus: 'idle',
      lastOscTitle: EXPLICIT_IDLE_TITLE,
      lastOscTitleAt: 1,
      lastOscTitleObservedAt: now,
      lastOutputAt: now,
      attachmentId: 'inc-1'
    }
    const cursor = captureTuiIdleEvidenceCursor(record)
    expect(
      observeTuiIdle({
        record,
        agent: 'codex',
        firstPartyStatus: null,
        evidenceCursor: cursor,
        readPositiveBodyEvidence: () => false
      })
    ).toMatchObject({ state: 'unknown', agent: 'codex' })
    expect(
      observeTuiIdle({
        record: { ...record, lastOscTitleAt: 2, lastOscTitleObservedAt: now + 1 },
        agent: 'codex',
        firstPartyStatus: null,
        evidenceCursor: cursor,
        readPositiveBodyEvidence: () => false
      })
    ).toMatchObject({ state: 'ready', source: 'title', agent: 'codex' })
  })

  // #12536: asking whether a terminal is idle must answer from what is true now. Fencing this
  // read against the operation that performs it demands a transition that already happened, so an
  // idle, silent agent never settles and the wait runs to timeout.
  it('settles a wait that starts on an already-idle terminal', async () => {
    const pty = makeTuiIdlePty({
      lastAgentStatus: 'idle',
      lastOscTitle: EXPLICIT_IDLE_TITLE
    })
    const { wait } = createWait({ pty, agent: 'codex' })
    await expect(
      wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 5_000 })
    ).resolves.toMatchObject({ satisfied: true })
  })

  // The protection a retained title needs is not "was this byte newer than my operation" — it is
  // that an unfinished provider turn has not been retracted. A stale working row is not permission
  // to promote the idle title that was already on screen before that turn opened.
  it('does not let a retained explicit title satisfy a wait while a provider turn is unfinished', async () => {
    const pty = makeTuiIdlePty({
      lastAgentStatus: 'idle',
      lastOscTitle: EXPLICIT_IDLE_TITLE
    })
    const { wait } = createWait({
      pty,
      agent: 'codex',
      firstPartyStatus: {
        state: 'working',
        updatedAt: Date.now() - 31 * 60 * 1000
      }
    })
    const result = wait.wait(HANDLE, { condition: 'tui-idle', timeoutMs: 5_000 })
    const settled = watch(result)

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(result).resolves.toMatchObject({ satisfied: false })
  })

  it('rejects newer readiness evidence from a replacement attachment', () => {
    const now = Date.now()
    const cursor = captureTuiIdleEvidenceCursor({
      lastAgentStatus: 'idle',
      lastOscTitle: NAME_ONLY_TITLE,
      lastOscTitleObservedAt: now,
      lastOutputAt: now,
      attachmentId: 'inc-1'
    })
    expect(
      observeTuiIdle({
        record: {
          lastAgentStatus: 'idle',
          lastOscTitle: EXPLICIT_IDLE_TITLE,
          lastOscTitleObservedAt: now + 1,
          lastOutputAt: now + 1,
          attachmentId: 'inc-2'
        },
        agent: 'codex',
        firstPartyStatus: null,
        evidenceCursor: cursor,
        readPositiveBodyEvidence: () => true,
        positiveBodyEvidenceAgent: 'codex'
      })
    ).toMatchObject({ state: 'unknown', agent: 'codex' })
  })

  it('accepts a current visible-screen observation without rewriting stream recency', () => {
    const now = Date.now()
    const cursor = captureTuiIdleEvidenceCursor({
      lastAgentStatus: 'idle',
      lastOscTitle: NAME_ONLY_TITLE,
      lastOutputAt: now,
      attachmentId: 'inc-1'
    })
    expect(
      observeTuiIdle({
        record: {
          lastAgentStatus: 'idle',
          lastOscTitle: NAME_ONLY_TITLE,
          lastOutputAt: now,
          screenCapture: {
            attachmentId: 'inc-1',
            generation: 1,
            outputSequence: 1,
            revision: 1,
            source: 'headless'
          },
          attachmentId: 'inc-1'
        },
        agent: 'codex',
        firstPartyStatus: null,
        evidenceCursor: cursor,
        readPositiveBodyEvidence: () => true,
        positiveBodyEvidenceAgent: 'codex'
      })
    ).toMatchObject({ state: 'ready', source: 'screen', agent: 'codex' })
  })

  it('rejects a cached screen replay even when a caller wall clock advances', () => {
    const capture = {
      attachmentId: 'inc-1',
      generation: 3,
      outputSequence: 42,
      revision: 7,
      source: 'headless' as const
    }
    const record: TuiIdleEvidenceRecord = {
      lastAgentStatus: 'idle',
      lastOscTitle: NAME_ONLY_TITLE,
      lastOutputAt: null,
      attachmentId: 'inc-1',
      screenCapture: capture,
      screenObservedAt: Date.now() + 10_000
    }
    const cursor = captureTuiIdleEvidenceCursor(record)
    expect(
      observeTuiIdle({
        record: { ...record, screenObservedAt: Date.now() + 20_000 },
        agent: 'codex',
        firstPartyStatus: null,
        evidenceCursor: cursor,
        readPositiveBodyEvidence: () => true,
        positiveBodyEvidenceAgent: 'codex'
      })
    ).toMatchObject({ state: 'unknown', agent: 'codex' })
  })

  it('accepts an unchanged screen only after a new host capture revision', () => {
    const capture = {
      attachmentId: 'inc-1',
      generation: 3,
      outputSequence: 42,
      revision: 7,
      source: 'headless' as const
    }
    const record: TuiIdleEvidenceRecord = {
      lastAgentStatus: 'idle',
      lastOscTitle: NAME_ONLY_TITLE,
      lastOutputAt: null,
      attachmentId: 'inc-1',
      screenCapture: capture
    }
    const cursor = captureTuiIdleEvidenceCursor(record)
    expect(
      observeTuiIdle({
        record: { ...record, screenCapture: { ...capture, revision: 8 } },
        agent: 'codex',
        firstPartyStatus: null,
        evidenceCursor: cursor,
        readPositiveBodyEvidence: () => true,
        positiveBodyEvidenceAgent: 'codex'
      })
    ).toMatchObject({ state: 'ready', source: 'screen', agent: 'codex' })
  })

  it('does not let a recapture of a pre-working screen outrank a stale working fact', () => {
    const capture = {
      attachmentId: 'inc-1',
      generation: 3,
      outputSequence: 42,
      revision: 8,
      source: 'headless' as const
    }
    const record: TuiIdleEvidenceRecord = {
      lastAgentStatus: 'idle',
      lastOscTitle: NAME_ONLY_TITLE,
      lastOutputAt: null,
      attachmentId: 'inc-1',
      screenCapture: capture
    }
    expect(
      observeTuiIdle({
        record,
        agent: 'codex',
        firstPartyStatus: {
          state: 'working',
          updatedAt: Date.now() - 31 * 60 * 1000,
          outputSequence: 42,
          attachmentId: 'inc-1'
        },
        evidenceCursor: captureTuiIdleEvidenceCursor({
          ...record,
          screenCapture: { ...capture, revision: 7 }
        }),
        readPositiveBodyEvidence: () => true,
        positiveBodyEvidenceAgent: 'codex'
      })
    ).toMatchObject({ state: 'unknown', source: 'first-party', agent: 'codex' })
    // The unrelated byte case: `ESC[H` moved the sequence 42 -> 43 and the probe took a fresh
    // capture, but the provider painted nothing and the screen still shows the pre-turn prompt.
    // Transport position dates OUR read, so it cannot retract the provider's own working claim.
    expect(
      observeTuiIdle({
        record: { ...record, screenCapture: { ...capture, outputSequence: 43, revision: 9 } },
        agent: 'codex',
        firstPartyStatus: {
          state: 'working',
          updatedAt: Date.now() - 31 * 60 * 1000,
          outputSequence: 42,
          attachmentId: 'inc-1'
        },
        evidenceCursor: captureTuiIdleEvidenceCursor({
          ...record,
          screenCapture: { ...capture, revision: 7 }
        }),
        readPositiveBodyEvidence: () => true,
        positiveBodyEvidenceAgent: 'codex'
      })
    ).toMatchObject({ state: 'unknown', source: 'first-party', agent: 'codex' })
  })

  it('lets the provider retract its own turn with a done frame', () => {
    const capture = {
      attachmentId: 'inc-1',
      generation: 3,
      outputSequence: 42,
      revision: 8,
      source: 'headless' as const
    }
    const record: TuiIdleEvidenceRecord = {
      lastAgentStatus: 'idle',
      lastOscTitle: NAME_ONLY_TITLE,
      lastOutputAt: null,
      attachmentId: 'inc-1',
      screenCapture: capture
    }
    // A `done` frame replaces the row outright, so there is no unfinished turn left to clear and
    // screen evidence is usable again. This is the path a normal Codex turn end takes.
    expect(
      observeTuiIdle({
        record: { ...record, screenCapture: { ...capture, revision: 9 } },
        agent: 'codex',
        firstPartyStatus: {
          state: 'done',
          updatedAt: Date.now() - 31 * 60 * 1000,
          outputSequence: 42,
          attachmentId: 'inc-1'
        },
        evidenceCursor: captureTuiIdleEvidenceCursor({
          ...record,
          screenCapture: { ...capture, revision: 8 }
        }),
        readPositiveBodyEvidence: () => true,
        positiveBodyEvidenceAgent: 'codex'
      })
    ).toMatchObject({ state: 'ready', source: 'screen', agent: 'codex' })
  })

  it('does not let a provider title unlock retained screen text after an open turn', () => {
    const capture = {
      attachmentId: 'inc-1',
      generation: 3,
      outputSequence: 42,
      revision: 8,
      source: 'headless' as const
    }
    const statusAt = Date.now() - 31 * 60 * 1000
    const record: TuiIdleEvidenceRecord = {
      lastAgentStatus: 'idle',
      // Name-only, so it carries no explicit idle marker of its own.
      lastOscTitle: NAME_ONLY_TITLE,
      lastOutputAt: null,
      lastOscTitleObservedAt: statusAt + 1_000,
      attachmentId: 'inc-1',
      screenCapture: capture
    }
    // The title is newer than the working row, so the provider did speak again — but a title
    // vouches only for itself. The retained ready banner underneath it still predates the turn.
    expect(
      observeTuiIdle({
        record: { ...record, screenCapture: { ...capture, revision: 9 } },
        agent: 'codex',
        firstPartyStatus: {
          state: 'working',
          updatedAt: statusAt,
          outputSequence: 42,
          attachmentId: 'inc-1'
        },
        evidenceCursor: captureTuiIdleEvidenceCursor({
          ...record,
          screenCapture: { ...capture, revision: 8 }
        }),
        readPositiveBodyEvidence: () => true,
        positiveBodyEvidenceAgent: 'codex'
      })
    ).not.toMatchObject({ state: 'ready' })
  })

  it('does not treat an unknown attachment as a wildcard for a replacement', () => {
    const cursor = captureTuiIdleEvidenceCursor({
      lastAgentStatus: 'idle',
      lastOscTitle: NAME_ONLY_TITLE,
      lastOutputAt: null,
      attachmentId: null,
      lastOscTitleAt: 1
    })
    expect(
      observeTuiIdle({
        record: {
          lastAgentStatus: 'idle',
          lastOscTitle: EXPLICIT_IDLE_TITLE,
          lastOutputAt: null,
          attachmentId: 'inc-replacement',
          lastOscTitleAt: 2
        },
        agent: 'codex',
        firstPartyStatus: null,
        evidenceCursor: cursor,
        readPositiveBodyEvidence: () => false
      })
    ).toMatchObject({ state: 'unknown', agent: 'codex' })
  })
})

const E2E_WORKTREE_ID = 'repo-1::/tmp/name-only-idle'
const E2E_LEAF_ID = '33333333-3333-4333-8333-333333333333'
const E2E_PTY_ID = 'pty-name-only-idle'
const WORKING_TITLE = '⠋ Codex'
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

const E2E_GRAPH = {
  tabs: [
    {
      tabId: 'tab-1',
      worktreeId: E2E_WORKTREE_ID,
      title: 'Agent',
      activeLeafId: E2E_LEAF_ID,
      layout: null
    }
  ],
  leaves: [
    {
      tabId: 'tab-1',
      worktreeId: E2E_WORKTREE_ID,
      leafId: E2E_LEAF_ID,
      paneRuntimeId: 1,
      ptyId: E2E_PTY_ID,
      paneTitle: null,
      title: ''
    }
  ]
} satisfies RuntimeSyncWindowGraph

async function makeRuntime(launchAgent?: TuiAgent) {
  // The agent process stays in the foreground; only its output and title move.
  const runtime = makeTuiIdleRuntime({
    repoPath: '/tmp/name-only-idle',
    getForegroundProcess: async () => 'codex'
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, E2E_GRAPH)
  if (launchAgent) {
    runtime.registerPty(E2E_PTY_ID, E2E_WORKTREE_ID, null, {
      tabId: 'tab-1',
      leafId: E2E_LEAF_ID,
      incarnationId: 'name-only-incarnation',
      agentLaunchAuthority: { launchToken: 'name-only-launch', launchAgent }
    })
  }
  const { terminals } = await runtime.listTerminals(`id:${E2E_WORKTREE_ID}`)
  return { runtime, handle: terminals[0].handle }
}

function oscTitle(title: string): string {
  return `${ESC}]0;${title}${BEL}`
}

describe('tui-idle over the live OSC title pipeline', () => {
  it('does not settle on a name-only title arriving mid-stream', async () => {
    const { runtime, handle } = await makeRuntime('codex')
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle(WORKING_TITLE)}building\n`, Date.now())

    const waiting = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 250 })
    // The agent is mid-turn and repaints its title to the bare product name.
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle(NAME_ONLY_TITLE)}more output\n`, Date.now())

    await expect(waiting).resolves.toMatchObject({
      satisfied: false,
      readiness: { state: 'unknown' }
    })
  })

  it('settles when the agent reports idle explicitly', async () => {
    const { runtime, handle } = await makeRuntime('codex')
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle(WORKING_TITLE)}building\n`, Date.now())

    const waiting = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_000 })
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle(NAME_ONLY_TITLE)}more output\n`, Date.now())
    runtime.onPtyData(E2E_PTY_ID, oscTitle(EXPLICIT_IDLE_TITLE), Date.now())

    await expect(waiting).resolves.toMatchObject({ condition: 'tui-idle', satisfied: true })
  })

  it('refuses a name-only title observed before the waiter registered', async () => {
    const { runtime, handle } = await makeRuntime('codex')
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle(NAME_ONLY_TITLE)}output\n`, Date.now())

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 250 })
    ).resolves.toMatchObject({ satisfied: false, readiness: { state: 'unknown' } })
  })

  it('returns unknown for an agent whose only rest signal is its name', async () => {
    const { runtime, handle } = await makeRuntime('grok')
    runtime.onPtyData(E2E_PTY_ID, `${oscTitle('grok')}banner\n`, Date.now())

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 100 })
    ).resolves.toMatchObject({
      condition: 'tui-idle',
      satisfied: false,
      readiness: { state: 'unsupported' }
    })
  })
})
