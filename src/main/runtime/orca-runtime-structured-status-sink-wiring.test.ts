import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

const installed = vi.hoisted(() => {
  const state: {
    deps: Record<string, unknown> | null
    logger: StructuredAgentSessionLogger | null
  } = { deps: null, logger: null }
  return state
})

vi.mock('../node-runtime/pinned-zip-members', () => ({
  extractPinnedZipMembers: () => {
    throw new Error('Mail fixtures must not install a runtime')
  }
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('./structured-agent-session-runtime', () => ({
  ensureStructuredAgentSessionHost: vi.fn(
    async (deps: Record<string, unknown> & { logger: StructuredAgentSessionLogger }) => {
      installed.deps = deps
      installed.logger = deps.logger
    }
  )
}))

import { OrcaRuntimeService } from './orca-runtime'
import { _resetTracerForTests, setActiveSink } from '../observability/tracer'
import type { StructuredAgentSessionStatusSink } from '../native-chat/agent-session-wire/structured-agent-session-status-feed'
import * as structuredMailTarget from './orchestration/structured-session-mail-target'
import { OrcaRuntimeWithRuntimeId } from './construction/runtime-identity-state'

describe('structured status sink wiring', () => {
  afterEach(() => {
    _resetTracerForTests()
    vi.restoreAllMocks()
  })

  it('hands the host the sink the runtime was constructed with', async () => {
    installed.deps = null
    const sink: StructuredAgentSessionStatusSink = { publish: vi.fn(), forget: vi.fn() }
    const runtime = new OrcaRuntimeService(null, undefined, { structuredAgentStatusSink: sink })

    await runtime.ensureStructuredAgentSessionHost()

    expect(installed.deps?.['statusSink']).toBe(sink)
    const capture = vi.spyOn(runtime, 'captureSessionMail').mockImplementation(function (
      this: OrcaRuntimeService
    ) {
      expect(this).toBe(runtime)
      return {}
    })
    const installedDeps = (): Record<string, unknown> | null => installed.deps
    const installedCapture = installedDeps()?.['captureSessionMail']
    if (typeof installedCapture !== 'function') {
      throw new Error('missing Stop capture installer')
    }
    installedCapture()
    installedCapture()
    expect(capture.mock.calls).toEqual([[], []])
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('hands the host the trace-file logger', async () => {
    installed.logger = null
    const push = vi.fn()
    setActiveSink({ push, flush: () => {}, close: () => {} })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const runtime = new OrcaRuntimeService()

    await runtime.ensureStructuredAgentSessionHost()
    const installedLogger = (): StructuredAgentSessionLogger | null => installed.logger
    installedLogger()?.warn('renewing a chat lease failed', {
      scope: 'lease-renewal',
      sessionId: 'session-1',
      error: new Error('database is locked')
    })

    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'agentSession.lease-renewal',
        attributes: expect.objectContaining({ sessionId: 'session-1' }),
        exit: expect.objectContaining({ _tag: 'Failure' })
      })
    )
  })

  it('installs without a sink when none was provided', async () => {
    installed.deps = null
    const runtime = new OrcaRuntimeService()

    await runtime.ensureStructuredAgentSessionHost()

    expect(installed.deps).not.toBeNull()
    expect('statusSink' in (installed.deps ?? {})).toBe(false)
  })
})

describe('mail dispatch through the current runtime', () => {
  afterEach(() => vi.restoreAllMocks())

  it('uses runtime overrides for the selected queue callback and actual idle edge, never descriptive repeats', async () => {
    const target = new OrcaRuntimeService()
    vi.spyOn(structuredMailTarget, 'structuredSessionIdleEdgeMailboxes').mockReturnValue([
      'term_mailbox'
    ])
    const events: string[] = []
    Object.defineProperties(target, {
      notifyStructuredSessionJournalActivity: {
        value: function (this: OrcaRuntimeService, sessionId: string) {
          expect(this).toBe(target)
          expect(arguments.length).toBe(1)
          events.push(`journal:${sessionId}`)
        }
      },
      deliverPendingMessagesForHandle: {
        value: function (this: OrcaRuntimeService, handle: string) {
          expect(this).toBe(target)
          expect(arguments.length).toBe(1)
          events.push(`delivery:${handle}`)
        }
      }
    })

    await target.ensureStructuredAgentSessionHost()
    installed.deps?.onSessionMailActivity?.('session-mailbox')
    expect(events).toEqual(['journal:session-mailbox'])
    events.length = 0
    target.onStructuredSessionStatusForMail({ sessionId: 'session-mailbox', status: 'working' })
    expect(events).toEqual([])
    events.length = 0
    target.onStructuredSessionStatusForMail({ sessionId: 'session-mailbox', status: 'idle' })
    expect(events).toEqual(['delivery:term_mailbox'])
    events.length = 0
    target.onStructuredSessionStatusForMail({ sessionId: 'session-mailbox', status: 'idle' })
    expect(events).toEqual([])
  })

  it('uses the runtime delivery override during repoint repair', () => {
    const target = new OrcaRuntimeService()
    const delivery = vi.fn(function (this: OrcaRuntimeService, handle: string) {
      expect(this).toBe(target)
      expect(arguments.length).toBe(1)
      expect(handle).toBe('term_mailbox')
    })
    Object.defineProperty(target, 'deliverPendingMessagesForHandle', { value: delivery })

    target['repointPendingMessagesForHandle']('term_mailbox')
    expect(delivery).toHaveBeenCalledOnce()
  })

  it('uses runtime coordinator and direct worker target overrides', () => {
    const target = new OrcaRuntimeService()
    Object.defineProperties(target, {
      resolveStructuredCoordinatorMailboxTarget: {
        value: function (this: OrcaRuntimeService, runId: string) {
          expect(this).toBe(target)
          expect(arguments.length).toBe(1)
          expect(runId).toBe('run-mailbox')
          return { sessionId: 'coordinator-session', dispatchId: null }
        }
      },
      resolveStructuredWorkerDirectMailboxTarget: {
        value: function (this: OrcaRuntimeService, handle: string) {
          expect(this).toBe(target)
          expect(arguments.length).toBe(1)
          expect(handle).toBe('term_mailbox')
          return { sessionId: 'worker-session', dispatchId: null }
        }
      }
    })

    expect(target['resolveStructuredMailboxTarget']('run:run-mailbox')).toEqual({
      sessionId: 'coordinator-session',
      dispatchId: null
    })
    expect(target['resolveStructuredMailboxTarget']('term_mailbox')).toEqual({
      sessionId: 'worker-session',
      dispatchId: null
    })
  })
})

abstract class MailSchedulerPhaseProbe extends OrcaRuntimeWithRuntimeId {
  readonly pendingMailDuringConstruction = this.mailPointerRepointScheduler.pendingCount
}

describe('input state before later runtime layers initialize', () => {
  it('makes the scheduler available immediately after the original base layer', () => {
    expect(
      Object.getOwnPropertyDescriptor(
        Reflect.construct(MailSchedulerPhaseProbe, []),
        'pendingMailDuringConstruction'
      )?.value
    ).toBe(0)
  })
})

describe('checked runtime construction', () => {
  it('installs subscription callbacks on the runtime with their real registry receiver', () => {
    const runtime = new OrcaRuntimeService()
    const cleanup = vi.fn()
    runtime.registerSubscriptionCleanup('construction-subscription', cleanup)
    runtime.cleanupSubscription('construction-subscription')
    expect(cleanup).toHaveBeenCalledOnce()
    runtime.cleanupSubscription('construction-subscription')
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('keeps constructor callbacks lazy and the canonical status producer identity', () => {
    const snapshot = vi.fn(() => [])
    const stopped = vi.fn()
    const runtime = new OrcaRuntimeService(null, undefined, {
      getAgentStatusSnapshot: snapshot,
      onPtyStopped: stopped
    })
    expect(runtime.getAgentStatusSnapshotFn).toBe(snapshot)
    expect(runtime['onPtyStopped']).toBe(stopped)
    expect(snapshot).not.toHaveBeenCalled()
    expect(stopped).not.toHaveBeenCalled()
  })
})
