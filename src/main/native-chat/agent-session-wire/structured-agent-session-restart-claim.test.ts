import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import {
  AGENT_SESSION_RESTART_CONTINUATION_MESSAGE,
  AGENT_SESSION_RESTART_CONTINUATION_NOTE
} from '../../../shared/agent-session-restart-continuation'
import { createStructuredAgentSessionRestartResume } from './structured-agent-session-restart-resume-host'
import {
  HANDLE_ROOT,
  journal,
  liveLeaseRecord,
  marker,
  NOW,
  record,
  SESSION,
  submission,
  turnItem,
  type HarnessSession
} from './structured-agent-session-restart-resume-test-harness'

function surface(input: {
  markers?: AgentSessionResumeMarker[]
  sessions?: Map<string, HarnessSession>
  record?: AgentSessionRecord
  holdFails?: boolean
  clearFails?: boolean
  /** Orca refused to take the message at all. */
  sendRefusal?: AgentSessionWireRefusal
  /**
   * The dispatch state SETTLEMENT reports. The send itself always answers `pending`, because that
   * is what the real host does: it resolves as soon as Orca owns the message, before the provider
   * has answered. Defaults to the delivered case.
   */
  settledDispatch?: 'pending' | 'accepted' | 'rejected' | 'unknown'
  settledReason?: string
  /** Nothing settled the send in time, which the waiter reports by resolving undefined. */
  settlementTimesOut?: boolean
  noteFails?: boolean
}) {
  const live = new Map((input.markers ?? [marker()]).map((entry) => [entry.sessionId, entry]))
  const recorded: AgentSessionResumeMarker[][] = []
  const held: string[] = []
  const noted: { sessionId: string; text: string }[] = []
  const store = {
    getRecord: () => input.record ?? record()
  }
  const recoveryCapsule = {
    record: async (markers: readonly AgentSessionResumeMarker[]) => {
      recorded.push([...markers])
      live.clear()
      markers.forEach((entry) => live.set(entry.sessionId, entry))
    },
    take: vi.fn(async () => {
      if (input.clearFails) {
        throw new Error('durable store refused the clear')
      }
      const markers = [...live.values()]
      live.clear()
      return markers
    })
  }
  const sent: { sessionId: string; text: string }[] = []
  const sessions =
    input.sessions ??
    new Map([
      [
        SESSION,
        {
          journal: journal([turnItem('turn-1', 'interrupted')]),
          hasProviderChild: false,
          fence: 1
        }
      ]
    ])
  // The note is written onto the session's own journal; intercept it there to assert attribution.
  for (const [sessionId, session] of sessions) {
    session.journal.appendItem = async (_envelope, body) => {
      if (input.noteFails) {
        throw new Error('journal refused the note')
      }
      noted.push({ sessionId, text: body.text })
    }
  }
  const noteFailures: { sessionId: string; error: unknown }[] = []
  return {
    restartResume: createStructuredAgentSessionRestartResume(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the collaborator reads only getRecord from the store, and supportsCreate from the adapter.
      {
        store,
        adapter: { supportsCreate: () => true },
        recoveryCapsule
      } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the live-session map is read for journal, hasProviderChild and fence only.
      sessions as never,
      {
        publish: () => {},
        revealSession: async () => ({ readable: true }),
        release: () => {},
        hold: async (sessionId: string) => {
          if (input.holdFails) {
            throw new Error('provider refused the reconnect')
          }
          held.push(sessionId)
        },
        send: async ({ envelope, body }) => {
          sent.push({
            sessionId: envelope.sessionId,
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restartContinuationBody builds exactly one text block, which is what this assertion reads.
            text: (body.blocks[0] as { text: string }).text
          })
          if (input.sendRefusal) {
            return { ok: false, refusal: input.sendRefusal }
          }
          // What the real send answers: Orca owns the message, the provider has not replied yet.
          return {
            ok: true,
            replayed: false,
            fence: 1,
            cursor: { epoch: 'epoch-1', sequence: 1 },
            value: {
              clientMessageId: envelope.clientOperationId,
              submission: submission(envelope.clientOperationId, 'pending')
            }
          }
        },
        awaitSendSettlement: async (_sessionId: string, clientMessageId: string) =>
          input.settlementTimesOut
            ? undefined
            : {
                value: {
                  clientMessageId,
                  submission: {
                    ...submission(clientMessageId, input.settledDispatch ?? 'accepted'),
                    reason: input.settledReason ?? null
                  }
                }
              },
        onNoteFailed: (sessionId: string, error: unknown) =>
          noteFailures.push({ sessionId, error }),
        now: () => NOW
      }
    ),
    live,
    recorded,
    held,
    sent,
    noted,
    noteFailures,
    recoveryCapsule
  }
}

describe('claiming the recovery capsule', () => {
  it('reports a failed take without logging private capsule or filesystem details', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { restartResume, recoveryCapsule, held, sent } = surface({})
      recoveryCapsule.take.mockRejectedValueOnce(new Error('private capsule payload and path'))
      expect(await restartResume.list()).toEqual([])
      expect(await restartResume.continueAfterRestart([SESSION], 'modal')).toEqual({
        resumed: [],
        continued: []
      })
      expect(held).toEqual([])
      expect(sent).toEqual([])
      expect(warning).toHaveBeenCalledWith(
        '[structured-agent-session] taking recovery capsule failed'
      )
      expect(warning.mock.calls.flat().map(String).join(' ')).not.toContain('private capsule')
    } finally {
      warning.mockRestore()
    }
  })

  it('shares one take across concurrent initial readers', async () => {
    const { restartResume, recoveryCapsule } = surface({})
    const results = await Promise.all([restartResume.list(), restartResume.list()])
    expect(results.map((items) => items.length)).toEqual([1, 1])
    expect(recoveryCapsule.take).toHaveBeenCalledTimes(1)
  })

  // The claim is the deletion. Everything on disk goes in one step — including markers this launch
  // refuses — so a later launch has nothing left to re-examine.
  it('deletes every durable marker at claim time, refused ones included', async () => {
    const { restartResume, live } = surface({
      markers: [marker(), marker({ sessionId: 'session-working-2', teardownId: 'launch-older' })]
    })

    await restartResume.list()

    expect(live.size).toBe(0)
  })

  // Fail closed again: if the delete throws, the markers are still live on disk, so acting on them
  // would be acting on something a later launch can also act on.
  it('claims nothing when the durable clear fails', async () => {
    const { restartResume, held } = surface({ clearFails: true })

    expect(await restartResume.list()).toEqual([])
    expect(await restartResume.resume(undefined, 'modal')).toEqual([])
    expect(held).toEqual([])
  })
})

describe('the restart-resume surface', () => {
  it('renders one journal snapshot per marked session when listing an offer', async () => {
    const sessionJournal = journal([turnItem('turn-1', 'interrupted')])
    const snapshot = vi.spyOn(sessionJournal, 'snapshot')
    const { restartResume } = surface({
      sessions: new Map([[SESSION, { journal: sessionJournal, hasProviderChild: false, fence: 1 }]])
    })

    expect(await restartResume.list()).toHaveLength(1)
    expect(snapshot).toHaveBeenCalledTimes(1)
  })

  // The structural guarantee behind "the checkbox can never continue": the reconnect path contains
  // no send at all, so no setting, and no automatic launch, can turn it into a continuation.
  it('never sends a message when reconnecting', async () => {
    const { restartResume, held, sent } = surface({})

    await restartResume.resume(undefined, 'modal')

    expect(held).toEqual([SESSION])
    expect(sent).toEqual([])
  })

  it('reconnects and then sends exactly one continuation carrying the shared message', async () => {
    const { restartResume, held, sent } = surface({})

    const result = await restartResume.continueAfterRestart(undefined, 'modal')

    expect(held).toEqual([SESSION])
    expect(sent).toEqual([{ sessionId: SESSION, text: AGENT_SESSION_RESTART_CONTINUATION_MESSAGE }])
    expect(result.continued).toEqual([{ sessionId: SESSION, outcome: 'continued' }])
  })

  // The predicate refused it, so it is not even a candidate and the loop never sees it.
  it('sends nothing to a session that was never eligible', async () => {
    const { restartResume, sent } = surface({
      markers: [marker({ work: { kind: 'turn', id: 'turn-elsewhere' } })]
    })

    const result = await restartResume.continueAfterRestart(undefined, 'modal')

    expect(sent).toEqual([])
    expect(result.continued).toEqual([])
  })

  // The case that actually exercises the gate: an ELIGIBLE session whose reconnect failed. It
  // reaches the loop as a refused outcome, and continuation must still not send to it.
  it('sends nothing to a session that did not reconnect', async () => {
    const { restartResume, sent, held } = surface({ holdFails: true })

    const result = await restartResume.continueAfterRestart(undefined, 'modal')

    expect(held).toEqual([])
    expect(sent).toEqual([])
    expect(result.continued).toEqual([
      { sessionId: SESSION, outcome: 'refused', reason: 'provider refused the reconnect' }
    ])
  })

  it('offers and resumes an eligible session', async () => {
    const { restartResume, held } = surface({})

    expect(await restartResume.list()).toHaveLength(1)
    await restartResume.resume(undefined, 'modal')

    expect(held).toEqual([SESSION])
  })

  // Turning the prompt down must not leave anything that can bring it back next launch — including
  // a marker that was never eligible in the first place.
  it('spends every live marker on dismiss, eligible or not', async () => {
    const ineligible = marker({
      sessionId: 'session-working-2',
      work: { kind: 'turn', id: 'turn-elsewhere' }
    })
    const { restartResume, live } = surface({ markers: [marker(), ineligible] })

    expect(await restartResume.dismiss()).toBe(2)

    expect(live.size).toBe(0)
    expect(await restartResume.list()).toEqual([])
  })

  // TOCTOU: the chat's own pane binds between the offer and the click, the lease goes live, and the
  // predicate drops the session. Reporting "nothing happened" would leave the user pressing a dead
  // button for a session that IS running.
  it('reports a session the chat pane already re-acquired as resumed, not as nothing', async () => {
    const { restartResume, held } = surface({
      record: liveLeaseRecord(),
      sessions: new Map([
        [SESSION, { journal: journal([turnItem('turn-1', 'interrupted')]), hasProviderChild: true }]
      ])
    })

    const outcomes = await restartResume.resume([SESSION], 'modal')

    expect(outcomes).toEqual([{ sessionId: SESSION, outcome: 'resumed' }])
    // Already-live sessions consume the same offer and use the same temporary request hold.
    expect(await restartResume.dismiss()).toBe(0)
    expect(held).toEqual([SESSION])
  })

  // Relaxing the lease clause must not relax the whole predicate. "Resume all" targets every
  // marker, so a held-but-ineligible session would otherwise be consumed and counted as resumed.
  it('refuses to settle an already-live session the predicate rejects', async () => {
    const { restartResume, held } = surface({
      record: liveLeaseRecord(),
      sessions: new Map([
        [SESSION, { journal: journal([turnItem('turn-1', 'completed')]), hasProviderChild: true }]
      ])
    })

    const outcomes = await restartResume.resume(undefined, 'modal')

    expect(outcomes).toEqual([])
    // The claim survives unspent: nothing was resumed, so nothing may be spent.
    expect(await restartResume.dismiss()).toBe(1)
    expect(held).toEqual([])
  })

  // The client names ids; only the host decides which of them may have a provider child.
  it('resumes nothing for a session id the caller invented', async () => {
    const { restartResume, held } = surface({})

    const outcomes = await restartResume.resume(['session-not-offered-1'], 'modal')

    expect(outcomes).toEqual([])
    expect(held).toEqual([])
  })

  // Quitting while the prompt is open: the offered session has no provider child in THIS
  // generation, so teardown mints no marker for it and the replace-the-whole-set write clears the
  // old one. The offer is discarded rather than resurrected, and nothing can double-fire.
  it('leaves no marker behind when the user quits with the offer still open', async () => {
    const { restartResume, live, recorded } = surface({})

    restartResume.captureMarkers('quit')
    await restartResume.recordMarkers()

    expect(recorded).toEqual([[]])
    expect(live.size).toBe(0)
  })

  it('re-marks a session whose resume is already running when the next quit lands', async () => {
    const { restartResume, recorded } = surface({
      sessions: new Map([
        [SESSION, { journal: journal([turnItem('turn-2', 'running')]), hasProviderChild: true }]
      ])
    })

    restartResume.captureMarkers('update')
    restartResume.confirmStoppedMarker(SESSION)
    await restartResume.recordMarkers()

    expect(recorded[0]).toEqual([
      {
        sessionId: SESSION,
        work: { kind: 'turn', id: 'turn-2' },
        recordedAt: NOW,
        trigger: 'update',
        teardownId: expect.any(String),
        providerHandleRoot: HANDLE_ROOT,
        latestUserItemId: null
      }
    ])
  })
})

describe('reporting what the continuation actually did', () => {
  // THE REGRESSION. A send resolves as soon as Orca owns the message, while its dispatch is still
  // `pending` — the ordinary successful path, not an edge case. Judging the dispatch on the send
  // result therefore calls every delivered continuation `pending` and never writes the note. This
  // fixture answers `pending` from send and `accepted` from settlement, exactly as the host does,
  // so a version that reads the send result fails here.
  it('waits for settlement before judging, so a delivered continuation is not read as pending', async () => {
    const { restartResume, noted } = surface({ settledDispatch: 'accepted' })

    const result = await restartResume.continueAfterRestart(undefined, 'modal')

    expect(result.continued).toEqual([{ sessionId: SESSION, outcome: 'continued' }])
    expect(noted).toHaveLength(1)
    expect(noted[0]?.sessionId).toBe(SESSION)
    expect(noted[0]?.text).toBe(AGENT_SESSION_RESTART_CONTINUATION_NOTE)
  })

  // The provider's own answer lives inside the submission. Reading only the envelope reports a
  // refused turn/start as continued and stamps the journal saying the agent was asked to carry on.
  it('reports a rejected dispatch as refused and writes no note', async () => {
    const { restartResume, noted } = surface({
      settledDispatch: 'rejected',
      settledReason: 'provider_turn_start_refused'
    })

    const result = await restartResume.continueAfterRestart(undefined, 'modal')

    expect(result.continued).toEqual([
      { sessionId: SESSION, outcome: 'refused', reason: 'provider_turn_start_refused' }
    ])
    expect(noted).toEqual([])
  })

  it('reports a send Orca could not hand off as refused and writes no note', async () => {
    const { restartResume, noted } = surface({
      sendRefusal: { code: 'agent_session_conflict', message: 'the runtime moved on' }
    })

    const result = await restartResume.continueAfterRestart(undefined, 'modal')

    expect(result.continued).toEqual([
      { sessionId: SESSION, outcome: 'refused', reason: 'agent_session_conflict' }
    ])
    expect(noted).toEqual([])
  })

  // Settlement gave up and the dispatch is STILL pending: handed off, never confirmed.
  it('reports a dispatch still pending after settlement as pending, with no note', async () => {
    const { restartResume, noted } = surface({ settledDispatch: 'pending' })

    const result = await restartResume.continueAfterRestart(undefined, 'modal')

    expect(result.continued).toEqual([{ sessionId: SESSION, outcome: 'pending' }])
    expect(noted).toEqual([])
  })

  it('reports an unverifiable dispatch as unknown and writes no note', async () => {
    const { restartResume, noted } = surface({ settledDispatch: 'unknown' })

    const result = await restartResume.continueAfterRestart(undefined, 'modal')

    expect(result.continued).toEqual([{ sessionId: SESSION, outcome: 'unknown' }])
    expect(noted).toEqual([])
  })

  // A waiter that timed out answers undefined, leaving only the send's own `pending`. That is not
  // proof of delivery either, so it must not fall through into success.
  it('claims no delivery when nothing ever settled the send', async () => {
    const { restartResume, noted } = surface({ settlementTimesOut: true })

    const result = await restartResume.continueAfterRestart(undefined, 'modal')

    expect(result.continued).toEqual([{ sessionId: SESSION, outcome: 'pending' }])
    expect(noted).toEqual([])
  })

  // The note stays best effort — a journal that refuses it must not turn a delivered continuation
  // into a failure — but its failure is REPORTED. This is the second silent swallow on this feature.
  it('reports a note it could not write instead of swallowing the failure', async () => {
    const { restartResume, noted, noteFailures } = surface({ noteFails: true })

    const result = await restartResume.continueAfterRestart(undefined, 'modal')

    expect(result.continued).toEqual([{ sessionId: SESSION, outcome: 'continued' }])
    expect(noted).toEqual([])
    expect(noteFailures).toHaveLength(1)
    expect(noteFailures[0]?.sessionId).toBe(SESSION)
  })
})
