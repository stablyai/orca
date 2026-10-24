import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { expect, it, vi } from 'vitest'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import {
  attach,
  hostTestState,
  serveHostTestChildWork
} from './structured-agent-session-host-test-harness'
import {
  childRecord,
  pendingApproval
} from './structured-agent-session-restart-resume-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'
import { inspect } from 'node:util'

it.each(['beginTeardown', 'captureBeforeStop', 'recordMarkers'] as const)(
  'keeps private %s failures out of logs while completing teardown',
  async (method) => {
    await attach()
    const { host, store, log } = hostTestState()
    const failure = new Error('private recovery payload at /private/account/session.json')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const operation = vi.spyOn(host.restartResume, method).mockImplementation(() => {
      throw failure
    })
    try {
      await expect(host.flushAllStreamedEvents()).resolves.toBeUndefined()
      expect(operation).toHaveBeenCalledOnce()
      expect(warning).toHaveBeenCalledOnce()
      expect(warning.mock.calls[0]?.[0]).toBe(
        {
          beginTeardown:
            '[agent-session] teardown-recovery-witnesses: capturing recovery witnesses for teardown failed',
          captureBeforeStop:
            '[agent-session] recovery-witness: capturing a recovery witness before a stop failed',
          recordMarkers:
            '[agent-session] teardown-recovery-capsule: recording the recovery capsule at teardown failed'
        }[method]
      )
      expect(inspect(warning.mock.calls, { depth: 8 })).not.toContain(failure.message)
      expect(log.scopes()).toContain(
        {
          beginTeardown: 'teardown-recovery-witnesses',
          captureBeforeStop: 'recovery-witness',
          recordMarkers: 'teardown-recovery-capsule'
        }[method]
      )
      expect(inspect(log.entries, { depth: 8 })).not.toContain('/private/account')
      expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
      await expect(host.journalSnapshot(SESSION)).rejects.toThrow('agent_session_ownership_unknown')
    } finally {
      operation.mockRestore()
      warning.mockRestore()
    }
  }
)

it.each(['approval', 'question', 'completed'])(
  'offers only unfinished work when an accepted %s event is queued at quit',
  async (event) => {
    await attach()
    const { host, root, acquire } = hostTestState()
    const events = acquire.mock.calls[0]?.[0].events
    if (!events) {
      throw new Error('missing provider event sink')
    }
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'working', ordinal: 1 },
      { kind: 'turn', turnId: 'working', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await host.flushStreamedEvents(SESSION)
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'working', ordinal: 2 },
      { kind: 'status', text: 'Provider is requesting approval' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'working', ordinal: 3 },
      event !== 'completed'
        ? {
            ...pendingApproval().body,
            question: 'Which action?',
            kind: event === 'approval' ? 'approval' : 'question'
          }
        : { kind: 'turn', turnId: 'working', state: 'completed' },
      { lifecycle: true, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await host.flushAllStreamedEvents()
    const offered = await new AgentSessionRecoveryCapsule(root).list(NOW)
    expect(offered.map((entry) => entry.work)).toEqual(
      event === 'completed' ? [] : [{ kind: 'turn', id: 'working' }]
    )
  }
)

// Judge work before Stop; provider close-time rows cannot invalidate that snapshot.
it.each(['approval', 'question', 'completed'] as const)(
  'offers work that was running at the stop even when a provider %s arrives during close',
  async (event) => {
    await attach()
    const { host, root, acquire } = hostTestState()
    const events = acquire.mock.calls[0]?.[0].events
    if (!events) {
      throw new Error('missing provider event sink')
    }
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'working', ordinal: 1 },
      { kind: 'turn', turnId: 'working', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await host.flushStreamedEvents(SESSION)
    host.deps.adapter.closeSession = async () => {
      events.appendItem(
        {
          provider: 'codex',
          threadId: THREAD,
          turnId: 'working',
          ordinal: event === 'completed' ? 1 : 2
        },
        event === 'completed'
          ? { kind: 'turn', turnId: 'working', state: 'completed' }
          : { ...pendingApproval().body, question: 'Which action?', kind: event },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      return true
    }
    await host.flushAllStreamedEvents()
    const offered = await new AgentSessionRecoveryCapsule(root).list(NOW)
    expect(offered.map((entry) => entry.work)).toEqual([{ kind: 'turn', id: 'working' }])
  }
)

it('marks a settled chat whose subagent was still running', async () => {
  let children: AgentChildWorkView[] = []
  serveHostTestChildWork(() => children)
  await attach()
  const { host, root, acquire } = hostTestState()
  const events = acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('missing provider event sink')
  }
  events.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'settled', ordinal: 1 },
    { kind: 'turn', turnId: 'settled', state: 'completed' },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await host.flushStreamedEvents(SESSION)
  children = [childRecord({ id: 'task-a', kind: 'agent', description: 'Review loop 4' })]
  await host.flushAllStreamedEvents()
  const [offered] = await new AgentSessionRecoveryCapsule(root).list(NOW)
  expect(offered?.work).toEqual({ kind: 'turn', id: 'settled' })
  expect(offered?.activity).toEqual({
    state: 'done',
    prompts: [],
    tasks: [{ kind: 'agent', label: 'Review loop 4' }]
  })
})

it('offers nothing for a chat whose child was not proven stopped', async () => {
  await attach()
  const { host, root, acquire } = hostTestState()
  const events = acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('missing provider event sink')
  }
  events.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'working', ordinal: 1 },
    { kind: 'turn', turnId: 'working', state: 'running' },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await host.flushStreamedEvents(SESSION)
  host.deps.adapter.closeSession = async () => false
  await host.flushAllStreamedEvents().catch(() => undefined)
  expect(await new AgentSessionRecoveryCapsule(root).list(NOW)).toEqual([])
  host.deps.adapter.closeSession = async () => true
})
