// A Stop that took effect still decides the turn it named after Orca restarts before the turn's end
// was written: the relaunch's settle reads the Stop's event, so the turn reads "Interrupted after N"
// with the muted mark, not "Failed". A turn nobody stopped, one a Stop never named, and one a
// turnless Stop was still settling when Orca died, still read as the news they are.

import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { agentVerdictDisplayMark } from '../../../shared/agent-main-agent-verdict'
import { agentTurnVerdict } from '../../../shared/agent-turn-outcome'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { formatNativeChatTurnStatusLabel } from '../../../shared/native-chat-turn-status'
import { selectStructuredAgentSettledTurns } from '../../../shared/structured-agent-session-turn-timing'
import { settleStaleStructuredAgentSessionState } from './structured-agent-session-dead-generation-settlement'
import { HOST_TEST_SESSION, hostTestOperationId } from './structured-agent-session-host-test-data'
import {
  QUEUED_RIG_CALLER,
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

const TURN = 'turn-1'
/** The provider rows a turn lives on: the Claude lane's, and Codex's. */
const CLAUDE_TURN: AgentJournalItemIdentity = {
  provider: 'claude',
  sessionId: 'provider-session-1',
  uuid: 'uuid-turn'
}
const CODEX_TURN: AgentJournalItemIdentity = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: TURN,
  ordinal: 999
}
const NEXT_TURN = 'turn-2'
const CODEX_NEXT_TURN: AgentJournalItemIdentity = {
  ...CODEX_TURN,
  turnId: NEXT_TURN,
  ordinal: 1000
}

let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

function journal() {
  const open = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

/** A send the provider is working on, with its turn running since half a minute ago. */
async function runningTurn(
  identity: AgentJournalItemIdentity,
  options: { stopEndsSession?: true } = {}
): Promise<void> {
  rig = await createQueuedMessageTestRig(options)
  await rig.workingSend()
  await journal().appendItem(
    identity,
    { kind: 'turn', turnId: TURN, state: 'running', startedAt: Date.now() - 30_000 },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

/** Orca dies with the turn's end unwritten; the relaunch reopens the chat from disk and proves
 *  the old child gone (its last renewal came before the Stop), then settles what it left. */
async function restartAndSettle(
  proof: 'pid-absent' | 'exit-observed' | 'unproven' = 'pid-absent'
): Promise<void> {
  rig.crashRestartHostProcess()
  await rig.host.journalSnapshot(HOST_TEST_SESSION)
  const now = Date.now()
  const deathEvidence: AgentSessionDeathEvidence | null =
    proof === 'unproven'
      ? null
      : {
          kind: proof,
          detail: 'the relaunch proved the old child gone',
          observedAt: now + 60_000,
          ownerFence: 1,
          lastProvenAliveAt: now - 20_000
        }
  await settleStaleStructuredAgentSessionState({
    journal: journal(),
    sessionId: HOST_TEST_SESSION,
    fence: 2,
    acquisitionGeneration: 'generation-2',
    deathEvidence
  })
}

/** What the chat's turn bar and the session's mark read, for `turnId` or else the first turn, and
 *  the error rows beside it. */
function settled(turnId?: string) {
  const { items } = journal().snapshot()
  const turn = items
    .map((item) => readAgentJournalTurn(item.body))
    .find((entry) => entry && (turnId === undefined || entry.turnId === turnId))
  const [timing] = [...selectStructuredAgentSettledTurns(items).values()]
  const verdict = turn
    ? agentTurnVerdict({ state: turn.state, outcome: turn.outcome ?? null })
    : null
  return {
    turn,
    label: timing ? formatNativeChatTurnStatusLabel({ elapsedSeconds: 0, ...timing }) : null,
    mark: verdict
      ? agentVerdictDisplayMark({ state: 'done', mainAgent: { state: 'done', outcome: verdict } })
      : null,
    errorRows: items.flatMap((item) =>
      item.body.kind === 'status' && item.body.tone === 'error' ? [item.body.text] : []
    )
  }
}

describe('a restart between a Stop and its turn end', () => {
  it.each([
    ['a Claude Stop before its result arrives', CLAUDE_TURN],
    ['a Codex Stop before turn/completed', CODEX_TURN]
  ])('reads Interrupted after N, marked interrupted: %s', async (_label, identity) => {
    await runningTurn(identity)
    // The provider took the interrupt; its end never arrived.
    expect(await rig.stop()).toMatchObject({ ok: true })

    await restartAndSettle()

    const { turn, label, mark, errorRows } = settled()
    expect(turn).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    expect(label).toMatch(/^Interrupted after /)
    expect(mark).toBe('interrupted')
    // A live Stop writes no row saying the provider stopped; nor does its relaunch.
    expect(errorRows).toEqual([])
  })

  // A Stop naming its turn, as the phone sends one: its event names the turn, which is what a
  // relaunch reads, so it still counts though Orca died with its interrupt out.
  it.each([
    ['Claude', CLAUDE_TURN],
    ['Codex', CODEX_TURN]
  ])('reads Interrupted after N for a %s Stop that named its turn', async (_label, identity) => {
    await runningTurn(identity)
    rig.cancelTurn.mockImplementationOnce(() => new Promise<never>(() => undefined))
    void rig.host.cancel(QUEUED_RIG_CALLER, {
      envelope: rig.envelope({ turnId: TURN }, 'agentSession.cancel', hostTestOperationId()),
      turnId: TURN
    })
    await expect.poll(() => journal().stopMarks.latest()?.event.turnId).toBe(TURN)

    await restartAndSettle()

    expect(settled().turn).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    expect(settled().label).toMatch(/^Interrupted after /)
  })

  it('reads Interrupted after N, marked interrupted: a close of the chat that died midway', async () => {
    await runningTurn(CODEX_TURN)
    // The host dies inside the close: the provider's close never answers, and nothing settles.
    rig.closeSession.mockImplementationOnce(() => Promise.reject(new Error('host died')))
    await expect(rig.host.close(HOST_TEST_SESSION, 'user-close')).rejects.toThrow()
    expect(journal().stopMarks.latest()?.event).toMatchObject({
      reason: 'user-close',
      turnId: TURN
    })

    await restartAndSettle()

    const { turn, label, mark, errorRows } = settled()
    expect(turn).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    expect(label).toMatch(/^Interrupted after /)
    expect(mark).toBe('interrupted')
    // A live Stop writes no row saying the provider stopped; nor does its relaunch.
    expect(errorRows).toEqual([])
  })

  // The notice row is the one explanation; the turn bar reads like a finished turn.
  it('reads Worked for N, marked failed, when nobody stopped it', async () => {
    await runningTurn(CODEX_TURN)

    await restartAndSettle()

    const { turn, label, mark, errorRows } = settled()
    expect(turn).toMatchObject({ state: 'interrupted' })
    expect(turn).not.toHaveProperty('outcome')
    expect(label).toMatch(/^Worked for /)
    expect(mark).toBe('failed')
    expect(errorRows).toEqual([
      expect.stringContaining('stopped while this response was in progress')
    ])
  })

  it("reads Couldn't confirm when the relaunch cannot prove the child gone, Stop or not", async () => {
    // The Stop says whose end it was, never that the turn ended.
    await runningTurn(CODEX_TURN)
    expect(await rig.stop()).toMatchObject({ ok: true })

    await restartAndSettle('unproven')

    const { turn, mark } = settled()
    expect(turn).toMatchObject({ state: 'unverifiable' })
    expect(mark).toBe('unconfirmed')
  })

  // Codex refuses a Stop naming a turn that is no longer its active one ("expected active turn id
  // X but found Y"), as a turn not running, so the child stays. The Stop names X, so Y's end is
  // never the person's, by its turn id alone.
  it('reads Failed for the turn running when the provider refused a Stop naming the one before it', async () => {
    await runningTurn(CODEX_TURN)
    rig.cancelTurn.mockResolvedValueOnce({
      cancelled: false,
      refusal: {
        detail: {
          text: `expected active turn id ${TURN} but found ${NEXT_TURN}`,
          audience: 'person'
        },
        turnNotRunning: true
      }
    })
    const fields = { turnId: TURN }
    expect(
      await rig.host.cancel(QUEUED_RIG_CALLER, {
        envelope: rig.envelope(fields, 'agentSession.cancel', hostTestOperationId()),
        ...fields
      })
    ).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(journal().stopMarks.latest()?.event).toMatchObject({ reason: 'user-stop', turnId: TURN })
    // The journal catches up: X had finished, and Y runs on until the crash.
    await journal().appendItem(
      CODEX_TURN,
      {
        kind: 'turn',
        turnId: TURN,
        state: 'completed',
        outcome: 'success',
        completedAt: Date.now()
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await journal().appendItem(
      CODEX_NEXT_TURN,
      { kind: 'turn', turnId: NEXT_TURN, state: 'running', startedAt: Date.now() - 10_000 },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )

    // Its exit is proven after the Stop, so only the turn the Stop named decides.
    await restartAndSettle('exit-observed')

    const { turn, mark } = settled(NEXT_TURN)
    expect(turn).toMatchObject({ state: 'interrupted' })
    expect(turn).not.toHaveProperty('outcome')
    expect(mark).toBe('failed')
  })

  // Claude's Stop ends its child whatever the interrupt answered.
  it('reads Interrupted after N when the provider refused a Stop that ends its child', async () => {
    await runningTurn(CLAUDE_TURN, { stopEndsSession: true })
    rig.cancelTurn.mockResolvedValueOnce({ cancelled: false, refusal: {} })
    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    // The Stop's next step on the session's lane ends the child.
    await rig.host['tasks'].serialize(HOST_TEST_SESSION, async () => {})
    expect(rig.closeSession).toHaveBeenCalled()

    await restartAndSettle()

    expect(settled().turn).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  })

  it('reads a turn a send made after a Stop pressed before any turn showed as no Stop of its', async () => {
    rig = await createQueuedMessageTestRig()
    const stopped = await rig.workingSend()
    // Pressed before the turn showed: the Stop names no turn.
    expect(await rig.stop()).toMatchObject({ ok: true })
    expect(journal().stopMarks.latest()?.event.turnId).toBeUndefined()
    await rig.settleAccepted(stopped, 'stopped')
    const next = rig.send('sent after the Stop')
    await next.result
    await rig.settleAccepted(next.id, 'next')
    await journal().appendItem(
      CODEX_TURN,
      { kind: 'turn', turnId: TURN, state: 'running', startedAt: Date.now() - 30_000 },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )

    // Its exit is proven after the Stop, so only whose turn it is decides.
    await restartAndSettle('exit-observed')

    expect(settled().turn).toMatchObject({ state: 'interrupted' })
    expect(settled().turn).not.toHaveProperty('outcome')
  })

  // A Stop pressed before any turn showed stopped the turn its interrupt took, and no other.
  it('reads a turn a host send opened after the turnless Stop ended its own turn as no Stop of its', async () => {
    rig = await createQueuedMessageTestRig()
    const stopped = await rig.workingSend()
    rig.cancelTurn.mockResolvedValueOnce({ cancelled: true, turnId: TURN })
    expect(await rig.stop()).toMatchObject({ ok: true })
    expect(journal().stopMarks.latest()?.event.turnId).toBeUndefined()
    await rig.settleAccepted(stopped, 'stopped')
    const scope = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    // Codex names the send that opened a turn on its row.
    const opener = agentJournalSubmissionKey(stopped)
    await journal().appendItem(
      CODEX_TURN,
      { kind: 'turn', turnId: TURN, state: 'running', startedAt: Date.now(), userItemId: opener },
      scope
    )
    await journal().appendItem(
      CODEX_TURN,
      {
        kind: 'turn',
        turnId: TURN,
        state: 'interrupted',
        completedAt: Date.now() + 1,
        userItemId: opener
      },
      scope
    )
    expect(settled(TURN).turn).toMatchObject({ outcome: 'cancellation' })
    // A send after the Stop, the queue's drain here, opens its own turn.
    const drained = rig.send('drained after the Stop', undefined, { internal: true })
    await drained.result
    await rig.settleAccepted(drained.id, 'drained')
    await journal().appendItem(
      CODEX_NEXT_TURN,
      {
        kind: 'turn',
        turnId: NEXT_TURN,
        state: 'running',
        startedAt: Date.now(),
        userItemId: agentJournalSubmissionKey(drained.id)
      },
      scope
    )

    // Its exit is proven after the Stop, so only which turn the Stop stopped decides.
    await restartAndSettle('exit-observed')

    expect(settled(NEXT_TURN).turn).toMatchObject({ state: 'interrupted' })
    expect(settled(NEXT_TURN).turn).not.toHaveProperty('outcome')
  })

  // What a turnless Stop binds is held in memory: a relaunch finds it unsettled, and it binds none.
  it('reads the turn a turnless Stop was settling when Orca died as no Stop of its', async () => {
    rig = await createQueuedMessageTestRig()
    const stopped = await rig.workingSend()
    // Orca dies while the interrupt is out: the Stop never settles.
    rig.cancelTurn.mockImplementationOnce(async () => {
      await journal().appendItem(
        CODEX_TURN,
        {
          kind: 'turn',
          turnId: TURN,
          state: 'running',
          startedAt: Date.now(),
          userItemId: agentJournalSubmissionKey(stopped)
        },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      return new Promise<never>(() => undefined)
    })
    void rig.stop()
    await expect.poll(() => journal().activeTurnId()).toBe(TURN)
    expect(journal().stopMarks.latest()?.event.turnId).toBeUndefined()

    await restartAndSettle('exit-observed')

    expect(settled(TURN).turn).toMatchObject({ state: 'interrupted' })
    expect(settled(TURN).turn).not.toHaveProperty('outcome')
  })

  // A refusal is no record: the first Stop stays the one in force, so pressing again repeats it.
  it('writes nothing for a Stop pressed again after the provider refused one', async () => {
    await runningTurn(CODEX_TURN)
    rig.cancelTurn.mockResolvedValueOnce({
      cancelled: false,
      refusal: { detail: { text: 'no active turn to interrupt', audience: 'person' } }
    })
    await rig.stop()
    const first = journal().stopMarks.latest()

    await rig.stop()

    expect(journal().stopMarks.latest()).toEqual(first)
  })
})
