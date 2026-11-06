import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session/records/agent-session-recovery-capsule'
import { afterEach, expect, it, vi } from 'vitest'
import { attach, hostTestState } from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'

afterEach(() => vi.useRealTimers())

// Teardown judged the chat working. Whether the agent got the cut-off send is never guessed: it stays
// sent (STA-7416), and the continuation asks the agent to check what finished.

// The row commits with its fold or not at all, and dispatch reads only committed sends.

// Teardown evicts indexed sessions before write-back; a real host catches lost snoozed-marker access.

it('serializes teardown publication behind an explicit dismissal', async () => {
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
  host.restartResume.beginTeardown('quit')
  host.restartResume.captureBeforeStop(SESSION)
  host.restartResume.confirmStopped(SESSION)

  const releaseRecord = Promise.withResolvers<void>()
  const originalRecord = AgentSessionRecoveryCapsule.prototype.record
  const record = vi.spyOn(AgentSessionRecoveryCapsule.prototype, 'record')
  record.mockImplementation(function (this: AgentSessionRecoveryCapsule, ...args) {
    return releaseRecord.promise.then(() => originalRecord.apply(this, args))
  })

  try {
    const recording = host.restartResume.recordMarkers()
    await Promise.resolve()
    const dismissed = host.restartResume.dismiss()
    releaseRecord.resolve()
    await Promise.all([recording, dismissed])
    expect(await new AgentSessionRecoveryCapsule(root).list(NOW)).toEqual([])
  } finally {
    record.mockRestore()
  }
})

// Renderer guidance keys on refusal code; retain details beside it.
