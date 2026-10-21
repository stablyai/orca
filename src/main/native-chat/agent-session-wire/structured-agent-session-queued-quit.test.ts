// A real quit with cards queued behind a running turn. The queue hands nothing off while the host
// quits, so the chat keeps its restart offer: after the relaunch nothing sends by itself, and
// resuming runs Orca's carry-on first, then the cards in order.

import { afterEach, expect, it, vi } from 'vitest'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import {
  interruptedRestart,
  QUEUED_BEFORE_QUIT
} from './structured-agent-session-restart-interruption-test-harness'

afterEach(() => vi.restoreAllMocks())

it('keeps the restart offer through a quit with cards queued; Resume sends the carry-on, then the cards in order', async () => {
  const { host, dispatch } = await interruptedRestart('queued-cards')
  // Nothing was handed off while the host quit.
  const snapshot = await host.journalSnapshot(SESSION)
  expect(snapshot.submissions.filter((entry) => entry.queuedMessageId !== undefined)).toEqual([])
  expect(await host.restartResume.list()).toHaveLength(1)
  const page = await host.history({ sessionId: SESSION, direction: 'tail' })
  expect(page.ok && page.page.queuePause).toBeFalsy()
  expect(page.ok && page.page.queuedMessages?.map((card) => card.state)).toEqual([
    'waiting',
    'waiting'
  ])
  await new Promise((resolve) => setTimeout(resolve, 250))
  expect(dispatch).not.toHaveBeenCalled()

  const resumed = await host.restartResume.continueAfterRestart([SESSION], 'modal')
  expect(resumed.continued).toMatchObject([{ sessionId: SESSION, outcome: 'continued' }])
  await vi.waitFor(() => expect(dispatch.mock.calls.length).toBeGreaterThanOrEqual(3))
  const sent = dispatch.mock.calls.map((call) => JSON.stringify(call[0]))
  expect(sent[0]).not.toContain('card')
  expect(sent[1]).toContain(QUEUED_BEFORE_QUIT[0])
  expect(sent[2]).toContain(QUEUED_BEFORE_QUIT[1])
})
