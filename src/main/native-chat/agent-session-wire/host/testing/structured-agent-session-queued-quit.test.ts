import { readTestHostJournal } from '../../../agent-session-journal/journal-observation.test-support'
import { afterEach, expect, it, vi } from 'vitest'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data.test-fixture'
import {
  interruptedRestart,
  QUEUED_BEFORE_QUIT
} from './structured-agent-session-restart-interruption.test-fixture'

afterEach(() => vi.restoreAllMocks())

it.each([undefined, 'kill-delivered'] as const)(
  'keeps %s evidence and the restart offer through a quit with cards queued; Resume sends the carry-on, then the cards in order',
  async (evidence) => {
    const { host, dispatch } = await interruptedRestart(
      'queued-cards',
      undefined,
      undefined,
      evidence
    )
    if (evidence) {
      expect(host.deps.store.getRecord(SESSION)?.lease.deathEvidence?.kind).toBe(evidence)
    }
    const snapshot = await readTestHostJournal(host, SESSION)
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
  }
)
