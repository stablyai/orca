// Failures the desktop host used to drop: it installed the runtime with no error callback, so
// each of these reached nobody. Every one now lands in the required logger under its own scope.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import type { StructuredAgentSessionHostDeps } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { StructuredAgentSessionHostRuntimeState } from '../native-chat/agent-session-wire/structured-agent-session-host-runtime-state'
import {
  StructuredAgentSessionDeliveryLoop,
  type StructuredAgentSessionDeliveryLoopDeps
} from '../native-chat/agent-session-wire/structured-agent-session-delivery-loop'
import {
  StructuredAgentSessionIdleSweep,
  type StructuredAgentSessionIdleSweepDeps
} from '../native-chat/agent-session-wire/structured-agent-session-idle-sweep'
import {
  StructuredAgentSessionQueuedMessageDrain,
  type QueuedMessageDrainDeps
} from '../native-chat/agent-session-wire/structured-agent-session-queued-messages'
import {
  createStructuredAgentSessionLogger,
  neverThrowingStructuredAgentSessionLogger
} from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { _resetTracerForTests, setActiveSink } from '../observability/tracer'
import { createStructuredAgentSessionDispatchFollowUps } from './structured-agent-session-dispatch-followups'
import { createStructuredAgentSessionLifecycleDelivery } from './structured-agent-session-lifecycle-delivery'
import {
  STRUCTURED_AGENT_SESSION_LOGGER_REQUIRED,
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

const SESSION = 'session-1'

function rejectingHost(error: Error) {
  return {
    settleLateDispatch: vi.fn(async () => {
      throw error
    }),
    releaseUnansweredDispatches: vi.fn(async () => {
      throw error
    })
  }
}

describe('failures the desktop host used to drop', () => {
  it('logs a late dispatch settlement that fails', async () => {
    const log = recordingStructuredAgentSessionLogger()
    const error = new Error('settlement write failed')
    const followUps = createStructuredAgentSessionDispatchFollowUps({
      host: () => rejectingHost(error),
      logger: log.logger
    })

    followUps.onDispatchSettledLate({
      sessionId: SESSION,
      clientMessageId: 'client-1',
      state: 'unknown',
      reason: 'provider went idle'
    })

    await vi.waitFor(() =>
      expect(log.entries).toEqual([
        {
          level: 'warn',
          message: 'settling a dispatch the provider answered late failed',
          fields: { scope: 'late-settlement', sessionId: SESSION, error }
        }
      ])
    )
  })

  it('logs releasing the sends an idle provider never answered when that fails', async () => {
    const log = recordingStructuredAgentSessionLogger()
    const error = new Error('release write failed')
    const followUps = createStructuredAgentSessionDispatchFollowUps({
      host: () => rejectingHost(error),
      logger: log.logger
    })

    followUps.releaseUnansweredDispatches({ sessionId: SESSION })

    await vi.waitFor(() =>
      expect(log.entries).toEqual([
        expect.objectContaining({
          fields: { scope: 'unanswered-dispatch', sessionId: SESSION, error }
        })
      ])
    )
  })

  it('logs a provider start or exit the host could not take', async () => {
    const log = recordingStructuredAgentSessionLogger()
    const error = new Error('host refused the event')
    const lifecycle = createStructuredAgentSessionLifecycleDelivery({
      handle: async () => {
        throw error
      },
      logger: log.logger,
      drainObservedExits: async () => {}
    })

    lifecycle.deliver({
      type: 'started',
      sessionId: SESSION,
      fence: 1,
      acquisitionGeneration: 'generation-1',
      reportedOptions: { model: 'gpt-5' },
      restoreSkippedOptions: []
    })
    lifecycle.deliver({
      type: 'ended',
      sessionId: SESSION,
      reason: 'exited',
      cause: 'unexpected-exit',
      fence: 1,
      acquisitionGeneration: 'generation-1'
    })
    await lifecycle.drain()

    expect(log.entries.map((entry) => entry.fields)).toEqual([
      { scope: 'lifecycle-started', sessionId: SESSION, error },
      { scope: 'lifecycle-exit', sessionId: SESSION, error }
    ])
  })

  it('logs provider events the chat journal would not take', async () => {
    const log = recordingStructuredAgentSessionLogger()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minting and binding a sink reads no other host dependency.
    const deps = { logger: log.logger } as unknown as StructuredAgentSessionHostDeps
    const runtime = new StructuredAgentSessionHostRuntimeState(deps, new Map())
    const sink = runtime.eventSinkFor(SESSION)
    const error = new Error('journal append failed')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sink calls only appendItem before it fails.
    const journal = {
      appendItem: async () => {
        throw error
      }
    } as unknown as AgentSessionJournal
    sink.bind({ journal, fence: 1, publish: () => {} })

    sink.sink.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'hi' }] },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await expect(sink.drained()).resolves.toMatchObject({ ok: false })

    expect(log.entries).toEqual([
      expect.objectContaining({
        level: 'error',
        fields: { scope: 'journal-event-sink', sessionId: SESSION, error }
      })
    ])
  })
})

describe('host collaborators log with their own scope', () => {
  const error = new Error('serialize refused')
  const rejectingSerialize = async (): Promise<never> => {
    throw error
  }

  it('the delivery loop logs a failed delivery, and a failed recording of it', async () => {
    const log = recordingStructuredAgentSessionLogger()
    const loop = new StructuredAgentSessionDeliveryLoop(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a step that rejects at its first serialize reads only these members.
      {
        serialize: rejectingSerialize,
        trackStart: <T>(start: Promise<T>) => start,
        logger: log.logger
      } as unknown as StructuredAgentSessionDeliveryLoopDeps
    )

    loop.wake(SESSION)

    await vi.waitFor(() =>
      expect(log.entries.map((entry) => entry.fields)).toEqual([
        { scope: 'delivery-loop', sessionId: SESSION, error },
        { scope: 'delivery-loop-fail', sessionId: SESSION, error }
      ])
    )
  })

  it('the idle sweep logs a step that fails', async () => {
    const log = recordingStructuredAgentSessionLogger()
    const sweep = new StructuredAgentSessionIdleSweep(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a tick whose serialize rejects reads only these members.
      {
        sessions: new Map([[SESSION, {}]]),
        isDisposed: () => false,
        serialize: rejectingSerialize,
        logger: log.logger
      } as unknown as StructuredAgentSessionIdleSweepDeps
    )

    await sweep.tick()

    expect(log.entries.map((entry) => entry.fields)).toEqual([
      { scope: 'idle-sweep', sessionId: SESSION, error }
    ])
  })

  it('the queued-message drain logs a step that fails', async () => {
    const log = recordingStructuredAgentSessionLogger()
    const journal = { queuedMessages: { settlementOwed: () => true } }
    const drain = new StructuredAgentSessionQueuedMessageDrain(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a schedule past the owed-settlement check reads only these members.
      {
        sessions: new Map([[SESSION, { journal }]]),
        serialize: rejectingSerialize,
        logger: log.logger
      } as unknown as QueuedMessageDrainDeps
    )

    drain.schedule(SESSION)

    await vi.waitFor(() =>
      expect(log.entries.map((entry) => entry.fields)).toEqual([
        { scope: 'queued-drain', sessionId: SESSION, error }
      ])
    )
  })
})

describe('a logger that throws', () => {
  it('never throws out of the report, and still prints what failed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const loggerError = new Error('logger broke')
    const logger = neverThrowingStructuredAgentSessionLogger({
      warn: () => {
        throw loggerError
      },
      error: () => {
        throw loggerError
      }
    })
    const error = new Error('what failed')

    expect(() => logger.warn('a step failed', { scope: 'step', error })).not.toThrow()
    expect(() => logger.error('a step failed', { scope: 'step', error })).not.toThrow()
    expect(warn).toHaveBeenCalledWith('[agent-session] a step failed', {
      scope: 'step',
      error,
      loggerError
    })
    warn.mockRestore()
  })
})

describe('the production logger', () => {
  afterEach(() => {
    _resetTracerForTests()
    vi.restoreAllMocks()
  })

  it('writes each entry to the trace file as a failed span named for its scope', () => {
    const push = vi.fn()
    setActiveSink({ push, flush: () => {}, close: () => {} })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    createStructuredAgentSessionLogger().warn('settling a late dispatch failed', {
      scope: 'late-settlement',
      sessionId: SESSION,
      error: new Error('disk full')
    })

    expect(push).toHaveBeenCalledOnce()
    expect(push.mock.calls[0]?.[0]).toMatchObject({
      type: 'effect-span',
      name: 'agentSession.late-settlement',
      attributes: {
        level: 'warn',
        message: 'settling a late dispatch failed',
        sessionId: SESSION
      },
      exit: { _tag: 'Failure', cause: expect.stringContaining('Error: disk full') }
    })
  })
})

describe('installing the runtime', () => {
  let stateDirectory: string | null = null

  afterEach(async () => {
    await stopStructuredAgentSessionRuntime()
    if (stateDirectory) {
      await rm(stateDirectory, { recursive: true, force: true })
      stateDirectory = null
    }
  })

  it('refuses without a logger rather than dropping every failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-logger-wiring-'))
    stateDirectory = root

    await expect(
      ensureStructuredAgentSessionHost(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deliberately missing the logger, as a `@ts-nocheck` caller could drop it.
        {
          stateDirectory: root,
          hostId: 'local',
          claimKeyId: 'key-1',
          resolveWorkspacePath: async () => root,
          resolveLaunchArgs: () => [],
          resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true })
        } as unknown as Parameters<typeof ensureStructuredAgentSessionHost>[0]
      )
    ).rejects.toThrow(STRUCTURED_AGENT_SESSION_LOGGER_REQUIRED)
  })

  it('hands the host a logger whose throw cannot reach the operation it reports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-logger-wiring-'))
    stateDirectory = root
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const host = await ensureStructuredAgentSessionHost({
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => root,
      resolveEnvironment: async () => ({}),
      resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
      logger: {
        warn: () => {
          throw new Error('logger broke')
        },
        error: () => {
          throw new Error('logger broke')
        }
      }
    })

    expect(() => host.deps.logger.warn('a step failed', { scope: 'step' })).not.toThrow()
  })
})
