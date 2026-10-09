// A Codex Stop that names no turn, sent after Codex answered a cold send and before it opened that
// turn, interrupts that turn at once. Refused as finding no turn while the turn has yet to run, it
// waits for the turn to open, or provably not to, and interrupts once more; it never waits for the
// send itself. The fake keeps Codex 0.157's turn bookkeeping: it answers before it opens the turn,
// and refuses an interrupt with no turn active until the thread runs.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CODEX_TEST_THREAD_ID,
  codexTurnLifecycleRig,
  settledWithin
} from './codex-structured-dispatch-test-support'
import { CODEX_TURN_OPEN_WAIT_MS } from './codex-structured-turn-open-wait'

type Rig = Awaited<ReturnType<typeof codexTurnLifecycleRig>>

const ADMITTED = { state: 'admitted' }
const REFUSED = { cancelled: false }
const NO_RUNNING_TURN = { cancelled: false, refusal: { turnNotRunning: true } }
const MAY_OPEN = { cancelled: false, refusal: { turnMayOpen: true } }

const stop = (rig: Rig) => rig.adapter.cancelTurn({ sessionId: 'session-1', fence: 7 })

/** A cold send Codex answered into `turn-1` and has not opened. */
async function answeredColdSend(rig: Rig): Promise<void> {
  const sending = rig.send('client-1')
  await vi.waitFor(() => expect(rig.turns.turnId).toBe('turn-1'))
  // The send is not held for the turn to open: its handover ends at the answer.
  expect(await settledWithin(sending)).toEqual(ADMITTED)
}

const interruptedTurns = (rig: Rig) => rig.interrupts().map((call) => call.params?.turnId)

/** A Stop under fake timers, read without awaiting it. */
function pressed(rig: Rig): () => unknown {
  let outcome: unknown = 'held'
  void stop(rig).then((value) => {
    outcome = value
  })
  return () => outcome
}

/** A Stop sent in the window before Codex's thread runs the turn: Codex refused its interrupt. */
async function waitingStop(rig: Rig) {
  await answeredColdSend(rig)
  const stopping = stop(rig)
  expect(await settledWithin(stopping)).toBe('held')
  expect(interruptedTurns(rig)).toEqual(['turn-1'])
  // Wrapped: an async function returning the promise itself would wait for it.
  return { stopping }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('a Codex send answered before its turn opens', () => {
  it('is admitted at the answer when no Stop is pending', async () => {
    const rig = await codexTurnLifecycleRig()

    await answeredColdSend(rig)

    expect(rig.turns.turnId).toBe('turn-1')
  })
})

describe("a no-turn Stop in the window between Codex's answer and its turn opening", () => {
  it("is taken at once once Codex's thread runs the turn", async () => {
    const rig = await codexTurnLifecycleRig()
    await answeredColdSend(rig)
    rig.turns.run()

    expect(await settledWithin(stop(rig))).toEqual({ cancelled: true, turnId: 'turn-1' })
    expect(interruptedTurns(rig)).toEqual(['turn-1'])
    await vi.waitFor(() => expect(rig.turns.turnId).toBeNull())
  })

  it('refused before the thread runs, waits for the turn to open and interrupts once more', async () => {
    const rig = await codexTurnLifecycleRig()
    const { stopping } = await waitingStop(rig)

    rig.turns.start()

    expect(await settledWithin(stopping)).toEqual({ cancelled: true, turnId: 'turn-1' })
    expect(interruptedTurns(rig)).toEqual(['turn-1', 'turn-1'])
    // Codex answers the interrupt, then ends the turn.
    await vi.waitFor(() => expect(rig.turns.turnId).toBeNull())
  })

  it('does not wait when Codex opened the turn before its answer was read', async () => {
    const rig = await codexTurnLifecycleRig()
    const release = rig.turns.holdNextAnswer()
    const sending = rig.send('client-1')
    await vi.waitFor(() => expect(rig.turns.turnId).toBe('turn-1'))
    rig.turns.start()
    release()
    await sending

    expect(await settledWithin(stop(rig))).toEqual({ cancelled: true, turnId: 'turn-1' })
  })

  it('does not wait for a send Codex steered into the running turn', async () => {
    const rig = await codexTurnLifecycleRig()
    await answeredColdSend(rig)
    rig.turns.start()
    expect(await settledWithin(rig.send('client-2'))).toEqual(ADMITTED)

    expect(await settledWithin(stop(rig))).toEqual({ cancelled: true, turnId: 'turn-1' })
    expect(rig.interrupts().map((call) => call.params?.turnId)).toEqual(['turn-1'])
  })

  it('stops nothing when the turn ends without opening', async () => {
    const rig = await codexTurnLifecycleRig()
    const { stopping } = await waitingStop(rig)

    rig.turns.end('interrupted')

    expect(await settledWithin(stopping)).toEqual(NO_RUNNING_TURN)
    expect(interruptedTurns(rig)).toEqual(['turn-1'])
  })

  // Codex ended the turn as the interrupt reached it: it refuses the turn as its last ended one.
  it('stops nothing, and waits for nothing, when Codex already ended the turn', async () => {
    const rig = await codexTurnLifecycleRig()
    await answeredColdSend(rig)
    const interrupt = rig.codex.routes['turn/interrupt']!
    rig.codex.routes['turn/interrupt'] = (params) => {
      rig.turns.end('completed')
      return interrupt(params)
    }

    expect(await settledWithin(stop(rig))).toEqual(NO_RUNNING_TURN)
    expect(interruptedTurns(rig)).toEqual(['turn-1'])
  })

  // The turn neither opened nor ended, and its send is still owed: no press calls that nothing.
  it.each(['idle', 'systemError'])(
    'answers refused, on the first press and on a second alike, when Codex reports the thread %s',
    async (type) => {
      const rig = await codexTurnLifecycleRig()
      const { stopping } = await waitingStop(rig)

      rig.notify('thread/status/changed', { threadId: CODEX_TEST_THREAD_ID, status: { type } })

      expect(await settledWithin(stopping)).toEqual(MAY_OPEN)
      // The second press's interrupt is refused too; it waits its own bound, then agrees.
      vi.useFakeTimers()
      const second = pressed(rig)
      await vi.advanceTimersByTimeAsync(CODEX_TURN_OPEN_WAIT_MS - 1)
      expect(second()).toBe('held')
      await vi.advanceTimersByTimeAsync(1)
      expect(second()).toEqual(MAY_OPEN)
      expect(interruptedTurns(rig)).toEqual(['turn-1', 'turn-1'])
    }
  )

  it('keeps waiting when a child thread stops running', async () => {
    const rig = await codexTurnLifecycleRig()
    const { stopping } = await waitingStop(rig)

    rig.notify('thread/status/changed', { threadId: 'thread-child', status: { type: 'idle' } })

    expect(await settledWithin(stopping)).toBe('held')
    rig.turns.start()
    expect(await settledWithin(stopping)).toEqual({ cancelled: true, turnId: 'turn-1' })
  })

  it('stops nothing when the child exits', async () => {
    const rig = await codexTurnLifecycleRig()
    const { stopping } = await waitingStop(rig)

    rig.codex.connections[0]!.handlers.onExit?.(new Error('codex app-server exited'))

    expect(await settledWithin(stopping)).toEqual(REFUSED)
    expect(interruptedTurns(rig)).toEqual(['turn-1'])
  })

  // The turn may still open and run: the host ends the child (`performCancel`).
  it('answers refused once its bound runs out', async () => {
    const rig = await codexTurnLifecycleRig()
    await answeredColdSend(rig)
    vi.useFakeTimers()
    const first = pressed(rig)

    await vi.advanceTimersByTimeAsync(CODEX_TURN_OPEN_WAIT_MS - 1)
    expect(first()).toBe('held')
    await vi.advanceTimersByTimeAsync(1)

    expect(first()).toEqual(MAY_OPEN)
    expect(interruptedTurns(rig)).toEqual(['turn-1'])
  })

  // A press after an earlier wait gave up waits again, so a turn that opens then is still stopped.
  it('waits again on a second press, and stops the turn if it opens then', async () => {
    const rig = await codexTurnLifecycleRig()
    await answeredColdSend(rig)
    vi.useFakeTimers()
    const first = pressed(rig)
    await vi.advanceTimersByTimeAsync(CODEX_TURN_OPEN_WAIT_MS)
    expect(first()).toEqual(MAY_OPEN)

    const second = pressed(rig)
    await vi.advanceTimersByTimeAsync(CODEX_TURN_OPEN_WAIT_MS - 1)
    expect(second()).toBe('held')
    rig.turns.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(second()).toEqual({ cancelled: true, turnId: 'turn-1' })
    expect(interruptedTurns(rig)).toEqual(['turn-1', 'turn-1', 'turn-1'])
  })
})

describe('a no-turn Stop with no turn Codex answered', () => {
  it('answers refused when the answer to the latest send was lost: Codex may still open its turn', async () => {
    const rig = await codexTurnLifecycleRig()

    const outcome = await rig.adapter.cancelTurn({
      sessionId: 'session-1',
      fence: 7,
      dispatchStatus: { state: 'unknown', recovered: false }
    })

    expect(outcome).toEqual({ cancelled: false, refusal: { turnMayOpen: true } })
    expect(rig.interrupts()).toEqual([])
  })

  it('stops nothing when nothing was sent, or the lost answer outlived its child', async () => {
    const rig = await codexTurnLifecycleRig()

    expect(await stop(rig)).toEqual(REFUSED)
    expect(
      await rig.adapter.cancelTurn({
        sessionId: 'session-1',
        fence: 7,
        dispatchStatus: { state: 'unknown', recovered: true }
      })
    ).toEqual(REFUSED)
  })
})
