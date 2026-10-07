import { afterEach, describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  openUnboundProviderTimelineAssembler,
  providerTurnId,
  providerTurnItemId
} from './provider-timeline-assembler-test-support'

afterEach(closeProviderTimelineRigs)

describe('provider timeline turns', () => {
  it('opens a running turn and settles it with the provider verdict and duration', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'input.accepted', clientMessageId: 'send-1', requestedAt: 900 })
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    expect(rig.assembler.openTurnId).toBe(providerTurnId('turn-1'))
    expect(await rig.turn('turn-1')).toEqual({
      turnId: providerTurnId('turn-1'),
      state: 'running',
      userItemId: agentJournalSubmissionKey('send-1'),
      startedAt: 1_000,
      requestedAt: 900
    })
    const runningRow = await rig.row(providerTurnItemId('turn-1'))
    // The running row is stamped at the turn start, not at append time.
    expect(runningRow?.observedAt).toBe(1_000)

    rig.assembler.apply({
      type: 'turn.end',
      at: 3_000,
      state: 'completed',
      outcome: 'success',
      durationMs: 1_800
    })
    expect(rig.assembler.openTurnId).toBeNull()
    const row = await rig.row(providerTurnItemId('turn-1'))
    expect(row?.body).toEqual({
      kind: 'turn',
      turnId: providerTurnId('turn-1'),
      state: 'completed',
      outcome: 'success',
      userItemId: agentJournalSubmissionKey('send-1'),
      startedAt: 1_000,
      requestedAt: 900,
      completedAt: 3_000,
      durationMs: 1_800
    })
    // Turn rows belong to no turn, and are revised rather than replaced.
    expect(row?.turnScope).toEqual({ kind: 'thread' })
    expect(row?.revision).toBeGreaterThan(runningRow?.revision ?? Infinity)
  })

  it('records a cancelled turn as interrupted with the cancellation verdict', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({
      type: 'turn.end',
      at: 2_000,
      state: 'interrupted',
      outcome: 'cancellation'
    })
    expect(await rig.turn('turn-1')).toMatchObject({
      state: 'interrupted',
      outcome: 'cancellation',
      completedAt: 2_000
    })
  })

  it('keeps a provider-reported failure a completed turn whose verdict says it failed', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'completed', outcome: 'failure' })
    expect(await rig.turn('turn-1')).toMatchObject({ state: 'completed', outcome: 'failure' })
  })

  it('leaves the verdict absent when the provider gave none', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'completed' })
    const turn = await rig.turn('turn-1')
    expect(turn?.state).toBe('completed')
    expect(turn).not.toHaveProperty('outcome')
  })

  it('mints a turn id when the provider names none, and keys a turn no send opened by its own row', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', at: 1_000 })
    const turnId = rig.assembler.openTurnId
    expect(turnId).toMatch(/^m:gen-1/)
    const rows = await rig.rows()
    const [row] = rows
    expect(rows).toHaveLength(1)
    expect(row?.body).toMatchObject({ kind: 'turn', turnId, userItemId: row?.itemId })
  })

  it('names the open turn with a send that arrives after a provider-opened turn began', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({ type: 'input.accepted', clientMessageId: 'send-1', requestedAt: 1_100 })
    // A second send folds into the turn; it does not replace the opener.
    rig.assembler.apply({ type: 'input.accepted', clientMessageId: 'send-2', requestedAt: 1_200 })
    expect(await rig.turn('turn-1')).toMatchObject({
      userItemId: agentJournalSubmissionKey('send-1'),
      requestedAt: 1_100
    })
  })

  it('gives each queued send to the next turn that opens, in order', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'input.accepted', clientMessageId: 'send-1', requestedAt: 900 })
    rig.assembler.apply({ type: 'input.accepted', clientMessageId: 'send-2', requestedAt: 950 })
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({ type: 'turn.end', at: 1_500, state: 'completed' })
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-2', at: 2_000 })
    expect((await rig.turn('turn-1'))?.userItemId).toBe(agentJournalSubmissionKey('send-1'))
    expect((await rig.turn('turn-2'))?.userItemId).toBe(agentJournalSubmissionKey('send-2'))
  })

  it('ends a still-open turn as superseded when the provider opens a different one', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-2', at: 2_000 })
    expect(await rig.turn('turn-1')).toMatchObject({
      state: 'interrupted',
      outcome: 'superseded',
      completedAt: 2_000
    })
    expect(await rig.turn('turn-2')).toMatchObject({ state: 'running', startedAt: 2_000 })
  })

  it('drops a repeated open and an end for a turn it never opened; a repeated end writes nothing', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    expect(rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_100 }).dropped).toBe(
      'turn-duplicate'
    )
    // An open naming no turn while one is open is the same turn, not a new one.
    expect(rig.assembler.apply({ type: 'turn.open', at: 1_200 }).dropped).toBe('turn-duplicate')
    expect(
      rig.assembler.apply({ type: 'turn.end', turn: 'turn-9', at: 1_500, state: 'completed' })
        .dropped
    ).toBe('turn-unknown')
    rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'completed', outcome: 'success' })
    // The journal holds the turn: its end is admitted and finds nothing left to settle.
    expect(
      rig.assembler.apply({ type: 'turn.end', turn: 'turn-1', at: 3_000, state: 'interrupted' })
    ).toEqual({ admission: { accepted: true } })
    expect(rig.assembler.apply({ type: 'turn.end', at: 3_000, state: 'completed' }).dropped).toBe(
      'no-turn'
    )
    // An open of a turn the journal holds settled neither reopens nor rewrites it.
    expect(rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 4_000 }).dropped).toBe(
      'turn-settled'
    )
    expect(await rig.turn('turn-1')).toMatchObject({
      state: 'completed',
      outcome: 'success',
      startedAt: 1_000,
      completedAt: 2_000
    })
  })

  it('writes nothing for an open admitted before bind whose row the journal already holds settled', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'completed', outcome: 'success' })
    await rig.rows()

    // Admitted without the journal's view, so only its write can see the row is there.
    const { assembler, bind } = openUnboundProviderTimelineAssembler(rig.journal)
    expect(
      assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 5_000 }).dropped
    ).toBeUndefined()
    await bind()
    expect(await rig.turn('turn-1')).toEqual({
      turnId: providerTurnId('turn-1'),
      state: 'completed',
      outcome: 'success',
      userItemId: providerTurnItemId('turn-1'),
      startedAt: 1_000,
      completedAt: 2_000
    })
    // The journal's settlement reaches the state at the next event.
    assembler.apply({ type: 'activity', text: 'reading' })
    expect(assembler.openTurnId).toBeNull()
  })
})
