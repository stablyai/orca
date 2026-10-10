import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { _resetTracerForTests, setActiveSink } from '../../observability/tracer'
import {
  AgentSessionRefusalError,
  agentSessionRefusalError,
  refuse
} from '../../../shared/agent-session-wire-refusals'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import {
  STRUCTURED_AGENT_SESSION_LOG_REPEAT_WINDOW_MS as WINDOW_MS,
  createStructuredAgentSessionLogRepeats
} from './structured-agent-session-log-repeats'

let push: Mock<(record: unknown) => void>
let clock: number

function written(): { name: string; attributes: Record<string, unknown>; exit: unknown }[] {
  // As the sink writes them: one JSON line per span.
  return JSON.parse(JSON.stringify(push.mock.calls.map(([span]) => span)))
}

beforeEach(() => {
  push = vi.fn<(record: unknown) => void>()
  clock = 1_000_000
  setActiveSink({ push, flush: () => {}, close: () => {} })
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  _resetTracerForTests()
  vi.restoreAllMocks()
})

describe('a failure that repeats', () => {
  it('is written once per window, then once more carrying how many repeats it swallowed', () => {
    const logger = createStructuredAgentSessionLogger({ now: () => clock })
    const renew = (): void =>
      logger.warn('renewing a chat lease failed', {
        scope: 'lease-renewal',
        sessionId: 'session-1',
        error: new Error('database is locked')
      })

    for (let tick = 0; tick < 30; tick += 1) {
      renew()
      clock += 10_000
    }
    expect(written()).toHaveLength(1)
    expect(written()[0]?.attributes).not.toHaveProperty('suppressed')
    expect(console.warn).toHaveBeenCalledOnce()

    clock += WINDOW_MS
    renew()
    expect(written()).toHaveLength(2)
    expect(written()[1]?.attributes).toMatchObject({ suppressed: 29, sessionId: 'session-1' })
    expect(console.warn).toHaveBeenLastCalledWith(
      '[agent-session] lease-renewal: renewing a chat lease failed',
      expect.objectContaining({ suppressed: 29 })
    )

    renew()
    expect(written()).toHaveLength(2)
  })

  it('never merges different sessions, scopes, levels, messages or errors', () => {
    const logger = createStructuredAgentSessionLogger({ now: () => clock })
    for (let round = 0; round < 3; round += 1) {
      logger.warn('renewing a chat lease failed', { scope: 'lease-renewal', sessionId: 'a' })
      logger.warn('renewing a chat lease failed', { scope: 'lease-renewal', sessionId: 'b' })
      logger.warn('renewing a chat lease failed', { scope: 'idle-sweep', sessionId: 'a' })
      logger.error('renewing a chat lease failed', { scope: 'lease-renewal', sessionId: 'a' })
      logger.warn('a different step failed', { scope: 'lease-renewal', sessionId: 'a' })
      logger.warn('a different step failed', {
        scope: 'lease-renewal',
        sessionId: 'a',
        error: new Error('disk full')
      })
    }

    expect(written().map((span) => [span.name, span.attributes['sessionId']])).toEqual([
      ['agentSession.lease-renewal', 'a'],
      ['agentSession.lease-renewal', 'b'],
      ['agentSession.idle-sweep', 'a'],
      ['agentSession.lease-renewal', 'a'],
      ['agentSession.lease-renewal', 'a'],
      ['agentSession.lease-renewal', 'a']
    ])
  })

  it('writes a failure whose cause, refusal reason or value differs, and swallows a true repeat', () => {
    const logger = createStructuredAgentSessionLogger({ now: () => clock })
    // A refusal's message is its bare code: only the cause tells these two apart.
    const unreadable = (cause: Error): Error =>
      new AgentSessionRefusalError(
        refuse(
          'agent_session_journal_unreadable',
          { reason: 'journalUnavailable' },
          'agent_session_journal_unreadable'
        ),
        { cause }
      )
    const report = (error: unknown): void =>
      logger.warn('recording an opened chat tab failed', {
        scope: 'tab-visibility-open',
        sessionId: 'session-1',
        error
      })
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const failing = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })

    report(unreadable(denied))
    report(unreadable(denied))
    report(unreadable(failing))
    report(
      agentSessionRefusalError('agent_session_journal_unreadable', { reason: 'journalCorrupt' })
    )
    report({ code: 'busy', attempt: 1 })
    report({ attempt: 1, code: 'busy' })
    report({ code: 'locked', attempt: 1 })

    expect(
      written().map((span) => span.attributes['errorCause'] ?? span.attributes['error'])
    ).toEqual([
      ['Error: EACCES: permission denied'],
      ['Error: EIO: i/o error'],
      undefined,
      { code: 'busy', attempt: 1 },
      { code: 'locked', attempt: 1 }
    ])
    expect(written()[2]?.attributes).toMatchObject({ refusalReason: 'journalCorrupt' })
    expect(written()[0]?.attributes).toMatchObject({ refusalReason: 'journalUnavailable' })
  })

  it('writes one message under another error name, or as a refusal, as separate failures', () => {
    const logger = createStructuredAgentSessionLogger({ now: () => clock })
    const renew = (error: Error): void =>
      logger.warn('renewing a chat lease failed', { scope: 'lease-renewal', sessionId: 'a', error })
    const unreadableRecord = (): Error => new Error('execution_owner_reconciling')
    const reconciling = (): Error =>
      agentSessionRefusalError('execution_owner_reconciling', { reason: 'hostReconciling' })

    for (let tick = 0; tick < 3; tick += 1) {
      renew(unreadableRecord())
      renew(reconciling())
      renew(new TypeError('execution_owner_reconciling'))
    }

    expect(written().map((span) => span.exit)).toEqual([
      expect.objectContaining({ cause: expect.stringMatching(/^Error: /) }),
      expect.objectContaining({ cause: expect.stringMatching(/^AgentSessionRefusalError: /) }),
      expect.objectContaining({ cause: expect.stringMatching(/^TypeError: /) })
    ])
  })

  it('tracks a bounded number of repeating entries', () => {
    const repeats = createStructuredAgentSessionLogRepeats({ now: () => clock, maxTracked: 2 })
    expect(repeats.admit('a')).toBe(0)
    expect(repeats.admit('b')).toBe(0)
    expect(repeats.admit('a')).toBeNull()
    // A third key evicts the one written longest ago, so `a` is written again.
    expect(repeats.admit('c')).toBe(0)
    expect(repeats.admit('a')).toBe(0)
    expect(repeats.admit('c')).toBeNull()
  })
})

describe('what an Error leaves in the trace file', () => {
  it('carries its code and its causes, depth-capped, by name and message only', () => {
    const denied = Object.assign(new Error('EACCES: permission denied, open'), {
      code: 'EACCES',
      path: '/private/payload'
    })
    const locked = Object.assign(new Error('database is locked'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 5
    })
    const chain = new Error('agent_session_store_corrupt', {
      cause: new Error('read failed', {
        cause: new Error('third', { cause: new Error('fourth', { cause: new Error('fifth') }) })
      })
    })

    const logger = createStructuredAgentSessionLogger({ now: () => clock })
    logger.warn('importing legacy records failed', { scope: 'legacy-record-import', error: chain })
    logger.warn('opening the journal failed', {
      scope: 'journal-database-open',
      error: new Error('opening failed', { cause: denied })
    })
    logger.error('writing events failed', { scope: 'journal-event-sink', error: locked })

    const [corrupt, open, sqlite] = written()
    expect(corrupt?.attributes['errorCause']).toEqual([
      'Error: read failed',
      'Error: third',
      'Error: fourth'
    ])
    expect(open?.attributes['errorCause']).toEqual(['Error: EACCES: permission denied, open'])
    expect(JSON.stringify(written())).not.toContain('/private/payload')
    expect(sqlite?.attributes).toMatchObject({ errorCode: 'ERR_SQLITE_ERROR', errorErrcode: 5 })
    expect(sqlite?.exit).toMatchObject({ cause: expect.stringContaining('database is locked') })
  })

  it('names the code of a cause whose message does not', () => {
    const logger = createStructuredAgentSessionLogger({ now: () => clock })
    logger.warn('x failed', {
      scope: 'x',
      error: new Error('x', { cause: Object.assign(new Error('no space'), { code: 'ENOSPC' }) })
    })
    expect(written()[0]?.attributes['errorCause']).toEqual(['Error: no space [ENOSPC]'])
  })
})
