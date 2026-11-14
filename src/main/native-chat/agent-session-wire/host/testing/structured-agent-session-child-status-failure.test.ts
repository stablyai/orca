import { expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { readTestHostJournal } from '../../../agent-session-journal/journal-observation.test-support'
import { attach, hostTestState } from './structured-agent-session-host.test-fixture'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD
} from './structured-agent-session-host-test-data.test-fixture'

it('keeps provider ingress running when early parent status publication fails', async () => {
  const { host, acquire, store } = hostTestState()
  host.deps.statusSink = {
    publish: () => {
      throw new Error('status observer unavailable')
    },
    forget: () => {}
  }
  const forceClose = vi.fn(async () => true)
  host.deps.adapter.forceCloseSession = forceClose
  await attach()
  const events = acquire.mock.calls.at(-1)?.[0].events
  if (!events) {
    throw new Error('Provider ingress was not acquired')
  }
  const identity = {
    provider: 'codex' as const,
    threadId: HOST_TEST_THREAD,
    turnId: 'still-running',
    ordinal: 50
  }
  events.appendItem(
    identity,
    { kind: 'turn', turnId: 'still-running', state: 'running' },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  host.publishChildWorkEvidence(
    HOST_TEST_SESSION,
    [
      {
        type: 'live',
        observedAt: HOST_TEST_NOW,
        child: {
          handle: { idKind: 'task_id', id: 'early-child' },
          kind: 'command',
          residency: 'background',
          state: 'working',
          stoppable: true
        }
      }
    ],
    events
  )
  events.appendItem(
    { ...identity, ordinal: 51 },
    { kind: 'status', text: 'Provider output after the observer failure' },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await host.flushStreamedEvents(HOST_TEST_SESSION)
  const journal = await readTestHostJournal(host, HOST_TEST_SESSION)
  expect(journal.items.map((item) => item.body)).toEqual([
    { kind: 'turn', turnId: 'still-running', state: 'running' },
    { kind: 'status', text: 'Provider output after the observer failure' }
  ])
  expect((await host.currentWork(HOST_TEST_SESSION))?.activeTurnId()).toBe('still-running')
  expect(store.getRecord(HOST_TEST_SESSION)?.lease.ownerProcess).not.toBeNull()
  expect(forceClose).not.toHaveBeenCalled()
})
