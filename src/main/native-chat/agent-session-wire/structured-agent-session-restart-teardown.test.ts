import { expect, it, vi } from 'vitest'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import { attach, hostTestState } from './structured-agent-session-host-test-harness'
import { pendingApproval } from './structured-agent-session-restart-resume-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'

it.each(['captureMarkers', 'recordMarkers'] as const)(
  'keeps private %s failures out of logs while completing teardown',
  async (method) => {
    await attach()
    const { host, store } = hostTestState()
    const failure = new Error('private recovery payload at /private/account/session.json')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const operation = vi.spyOn(host.restartResume, method).mockImplementation(() => {
      throw failure
    })
    try {
      await expect(host.flushAllStreamedEvents()).resolves.toBeUndefined()
      expect(operation).toHaveBeenCalledOnce()
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        method === 'captureMarkers'
          ? '[structured-agent-session] capturing recovery witnesses failed'
          : '[structured-agent-session] recording recovery capsule failed'
      )
      expect(warning.mock.calls.flat().map(String).join(' ')).not.toContain(failure.message)
      expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
      expect(() => host.journalSnapshot(SESSION)).toThrow('agent_session_ownership_unknown')
    } finally {
      operation.mockRestore()
      warning.mockRestore()
    }
  }
)

it.each(['approval', 'question', 'completed'])(
  'does not offer work with an accepted %s event queued at quit',
  async (event) => {
    await attach()
    const { host, root, acquire } = hostTestState()
    const events = acquire.mock.calls[0]?.[0].events
    if (!events) {
      throw new Error('missing provider event sink')
    }
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'working', ordinal: 1 },
      { kind: 'turn', turnId: 'working', state: 'running' }
    )
    await host.flushStreamedEvents(SESSION)
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'working', ordinal: 2 },
      { kind: 'status', text: 'Provider is requesting approval' }
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
      { lifecycle: true }
    )
    await host.flushAllStreamedEvents()
    expect(await new AgentSessionRecoveryCapsule(root).take(NOW)).toEqual([])
  }
)

it.each(['approval', 'question', 'completed'] as const)(
  'does not offer work superseded by a provider %s during close',
  async (event) => {
    await attach()
    const { host, root, acquire } = hostTestState()
    const events = acquire.mock.calls[0]?.[0].events
    if (!events) {
      throw new Error('missing provider event sink')
    }
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'working', ordinal: 1 },
      { kind: 'turn', turnId: 'working', state: 'running' }
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
          : { ...pendingApproval().body, question: 'Which action?', kind: event }
      )
      return true
    }
    await host.flushAllStreamedEvents()
    expect(await new AgentSessionRecoveryCapsule(root).take(NOW)).toEqual([])
  }
)
