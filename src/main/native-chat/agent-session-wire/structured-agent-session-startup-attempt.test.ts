import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  STRUCTURED_AGENT_SESSION_STARTUP_CEILING_MS as CEILING_MS,
  STRUCTURED_AGENT_SESSION_STARTUP_SILENCE_MS as SILENCE_MS
} from './structured-agent-session-startup-attempt-contract'
import {
  StructuredAgentSessionStartupAttempts,
  mintStructuredAgentSessionStartupAttempt,
  type StructuredAgentSessionExpiredStartup,
  type StructuredAgentSessionStartupSettled
} from './structured-agent-session-startup-attempt'

const SESSION = 'session-alpha'
const CHILD = { generation: 'generation-1', fence: 3 }

let expired: StructuredAgentSessionExpiredStartup[]
let settled: StructuredAgentSessionStartupSettled[]
let attempts: StructuredAgentSessionStartupAttempts

function mint() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mint reads only the lease fence, location, account home and options this literal sets.
  const record = {
    lease: { runtimeFence: CHILD.fence },
    location: { executionHostId: 'local', workspaceId: 'workspace-1' },
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' }
  } as unknown as AgentSessionRecord
  return mintStructuredAgentSessionStartupAttempt({
    record,
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: null
    },
    spawnToken: 'spawn-1',
    optionRevision: () => 0
  })
}

/** Output every `everyMs` for `forMs`. */
function chatter(output: () => void, forMs: number, everyMs = 10_000): void {
  for (let elapsed = 0; elapsed < forMs; elapsed += everyMs) {
    vi.advanceTimersByTime(everyMs)
    output()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  expired = []
  settled = []
  attempts = new StructuredAgentSessionStartupAttempts({
    expire: (startup) => expired.push(startup),
    settled: (startup) => settled.push(startup)
  })
})

afterEach(() => {
  attempts.dispose()
  vi.useRealTimers()
})

describe('the startup clock', () => {
  it('does not run before the spawn: resolving a launch is not starting', () => {
    attempts.track(SESSION, mint())

    vi.advanceTimersByTime(CEILING_MS * 2)

    expect(expired).toEqual([])
  })

  it('fails a spawned agent that says nothing for the silence limit, naming the acquire', () => {
    const attempt = mint()
    attempts.track(SESSION, attempt).spawned()

    vi.advanceTimersByTime(SILENCE_MS - 1)
    expect(expired).toEqual([])
    vi.advanceTimersByTime(1)

    expect(expired).toEqual([{ sessionId: SESSION, attemptId: attempt.attemptId, child: null }])
    vi.advanceTimersByTime(CEILING_MS)
    expect(expired).toHaveLength(1)
    // Measured at the limit, recorded once the aborted acquire settles.
    expect(settled).toEqual([])
    attempts.abandon(SESSION, attempt.attemptId)
    expect(settled).toEqual([{ agent: 'codex', outcome: 'silent', durationMs: SILENCE_MS }])
  })

  it('records a start that turned ready as the limit fired as ready', () => {
    const attempt = mint()
    attempts.track(SESSION, attempt).spawned()
    vi.advanceTimersByTime(SILENCE_MS)
    expect(expired).toHaveLength(1)

    attempts.published(SESSION, attempt.attemptId, { ...CHILD, phase: 'ready' })

    expect(settled).toEqual([{ agent: 'codex', outcome: 'ready', durationMs: SILENCE_MS }])
  })

  it('keeps a slow start that is still talking past the silence limit', () => {
    const attempt = mint()
    const progress = attempts.track(SESSION, attempt)
    progress.spawned()
    attempts.published(SESSION, attempt.attemptId, { ...CHILD, phase: 'starting' })

    chatter(progress.output, SILENCE_MS * 3)
    attempts.ready(SESSION, CHILD)

    expect(expired).toEqual([])
    expect(settled).toEqual([{ agent: 'codex', outcome: 'ready', durationMs: SILENCE_MS * 3 }])
    expect(attempts.isOpen(SESSION)).toBe(false)
  })

  it('times silence from the last output, not the spawn', () => {
    const progress = attempts.track(SESSION, mint())
    progress.spawned()
    vi.advanceTimersByTime(SILENCE_MS - 1_000)
    progress.output()

    vi.advanceTimersByTime(SILENCE_MS - 1)
    expect(expired).toEqual([])
    vi.advanceTimersByTime(1)

    expect(expired).toHaveLength(1)
  })

  it('fails a chatty agent that never becomes ready at the ceiling', () => {
    const attempt = mint()
    const progress = attempts.track(SESSION, attempt)
    progress.spawned()
    attempts.published(SESSION, attempt.attemptId, { ...CHILD, phase: 'starting' })

    chatter(progress.output, CEILING_MS - 10_000)
    expect(expired).toEqual([])
    chatter(progress.output, 10_000)

    expect(expired).toEqual([{ sessionId: SESSION, attemptId: attempt.attemptId, child: CHILD }])
    expect(settled).toEqual([{ agent: 'codex', outcome: 'ceiling', durationMs: CEILING_MS }])
  })

  it('starts on output or publication when no spawn was reported', () => {
    const byOutput = mint()
    attempts.track(SESSION, byOutput).output()
    const byPublish = mint()
    attempts.track('session-beta', byPublish)
    attempts.published('session-beta', byPublish.attemptId, { ...CHILD, phase: 'starting' })

    vi.advanceTimersByTime(SILENCE_MS)

    expect(expired.map((startup) => startup.attemptId).sort()).toEqual(
      [byOutput.attemptId, byPublish.attemptId].sort()
    )
  })
})

describe('an attempt ends', () => {
  it('with the start its child proved, and ignores a stale child’s proof', () => {
    const attempt = mint()
    attempts.track(SESSION, attempt).spawned()
    attempts.published(SESSION, attempt.attemptId, { ...CHILD, phase: 'starting' })

    attempts.ready(SESSION, { ...CHILD, generation: 'generation-0' })
    expect(attempts.isOpen(SESSION)).toBe(true)
    attempts.ready(SESSION, CHILD)
    vi.advanceTimersByTime(CEILING_MS)

    expect(expired).toEqual([])
    expect(attempts.isOpen(SESSION)).toBe(false)
  })

  it('with its child, however the child ended, leaving no entry or timer', () => {
    const attempt = mint()
    attempts.track(SESSION, attempt).spawned()
    attempts.published(SESSION, attempt.attemptId, { ...CHILD, phase: 'starting' })

    attempts.childEnded(SESSION, { ...CHILD, generation: 'generation-0' })
    expect(attempts.isOpen(SESSION)).toBe(true)
    attempts.childEnded(SESSION, CHILD)

    expect(attempts.isOpen(SESSION)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(settled.map((startup) => startup.outcome)).toEqual(['ended'])
  })

  it('once an expiry has stopped its published child', () => {
    const attempt = mint()
    attempts.track(SESSION, attempt).spawned()
    attempts.published(SESSION, attempt.attemptId, { ...CHILD, phase: 'starting' })

    vi.advanceTimersByTime(SILENCE_MS)

    expect(expired).toHaveLength(1)
    expect(attempts.isOpen(SESSION)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('when an acquire the expiry aborted is abandoned, or publishes late and is expired then', () => {
    const abandoned = mint()
    attempts.track(SESSION, abandoned).spawned()
    vi.advanceTimersByTime(SILENCE_MS)
    expect(attempts.isOpen(SESSION)).toBe(true)
    attempts.abandon(SESSION, abandoned.attemptId)
    expect(attempts.isOpen(SESSION)).toBe(false)

    const late = mint()
    attempts.track(SESSION, late).spawned()
    vi.advanceTimersByTime(SILENCE_MS)
    attempts.published(SESSION, late.attemptId, { ...CHILD, phase: 'starting' })

    expect(expired.map((startup) => startup.child)).toEqual([null, null, CHILD])
    expect(attempts.isOpen(SESSION)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    // Each start is measured once, at the limit that ended it.
    expect(settled.map((startup) => startup.outcome)).toEqual(['silent', 'silent'])
  })

  it('with an acquire that answered ready, or an attach that failed', () => {
    const ready = mint()
    attempts.track(SESSION, ready).spawned()
    attempts.published(SESSION, ready.attemptId, { ...CHILD, phase: 'ready' })
    const failed = mint()
    attempts.track('session-beta', failed).spawned()
    attempts.abandon('session-beta', failed.attemptId)

    vi.advanceTimersByTime(CEILING_MS)

    expect(expired).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('when the next attempt replaces it, and every clock stops at quit', () => {
    const first = mint()
    const firstProgress = attempts.track(SESSION, first)
    firstProgress.spawned()
    const second = mint()
    attempts.track(SESSION, second).spawned()
    // The replaced attempt's reports reach nothing.
    firstProgress.output()
    attempts.abandon(SESSION, first.attemptId)
    expect(attempts.isOpen(SESSION)).toBe(true)

    attempts.dispose()
    vi.advanceTimersByTime(CEILING_MS)

    expect(expired).toEqual([])
    expect(attempts.isOpen(SESSION)).toBe(false)
  })
})
