// A Codex Stop that names no turn, sent after Codex answered a cold send and before it opened that
// turn, waits for the turn to open, or provably not to, and never the send itself. The fake keeps
// Codex 0.157's turn bookkeeping: it answers before it opens the turn, and refuses an interrupt
// until then.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CODEX_TEST_THREAD_ID,
  codexTurnLifecycleRig,
  settledWithin
} from './codex-structured-dispatch-test-support'
import { CODEX_TURN_OPEN_WAIT_MS, codexLiveWork } from './codex-structured-turn-open-wait'

type Rig = Awaited<ReturnType<typeof codexTurnLifecycleRig>>

const ADMITTED = { state: 'admitted' }
const REFUSED = { cancelled: false }

const stop = (rig: Rig) => rig.adapter.cancelTurn({ sessionId: 'session-1', fence: 7 })

/** A cold send Codex answered into `turn-1` and has not opened. */
async function answeredColdSend(rig: Rig): Promise<void> {
  const sending = rig.send('client-1')
  await vi.waitFor(() => expect(rig.turns.turnId).toBe('turn-1'))
  // The send is not held for the turn to open: its handover ends at the answer.
  expect(await settledWithin(sending)).toEqual(ADMITTED)
}

/** A Stop sent in the window, which Codex would refuse if it reached Codex now. */
async function waitingStop(rig: Rig) {
  await answeredColdSend(rig)
  const stopping = stop(rig)
  expect(await settledWithin(stopping)).toBe('held')
  expect(rig.interrupts()).toEqual([])
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
  it('waits for the turn to open, then stops it', async () => {
    const rig = await codexTurnLifecycleRig()
    const { stopping } = await waitingStop(rig)

    rig.turns.start()

    expect(await settledWithin(stopping)).toEqual({ cancelled: true })
    expect(rig.interrupts().map((call) => call.params?.turnId)).toEqual(['turn-1'])
    expect(rig.turns.turnId).toBeNull()
  })

  it('does not wait when Codex opened the turn before its answer was read', async () => {
    const rig = await codexTurnLifecycleRig()
    const release = rig.turns.holdNextAnswer()
    const sending = rig.send('client-1')
    await vi.waitFor(() => expect(rig.turns.turnId).toBe('turn-1'))
    rig.turns.start()
    release()
    await sending

    expect(await settledWithin(stop(rig))).toEqual({ cancelled: true })
  })

  it('does not wait for a send Codex steered into the running turn', async () => {
    const rig = await codexTurnLifecycleRig()
    await answeredColdSend(rig)
    rig.turns.start()
    expect(await settledWithin(rig.send('client-2'))).toEqual(ADMITTED)

    expect(await settledWithin(stop(rig))).toEqual({ cancelled: true })
    expect(rig.interrupts().map((call) => call.params?.turnId)).toEqual(['turn-1'])
  })

  it('stops nothing when the turn ends without opening', async () => {
    const rig = await codexTurnLifecycleRig()
    const { stopping } = await waitingStop(rig)

    rig.turns.end('interrupted')

    expect(await settledWithin(stopping)).toEqual(REFUSED)
    expect(rig.interrupts()).toEqual([])
  })

  it.each(['idle', 'systemError'])(
    'stops nothing when Codex reports the thread %s',
    async (type) => {
      const rig = await codexTurnLifecycleRig()
      const { stopping } = await waitingStop(rig)

      rig.notify('thread/status/changed', { threadId: CODEX_TEST_THREAD_ID, status: { type } })

      expect(await settledWithin(stopping)).toEqual(REFUSED)
      expect(rig.interrupts()).toEqual([])
    }
  )

  it('keeps waiting when a child thread stops running', async () => {
    const rig = await codexTurnLifecycleRig()
    const { stopping } = await waitingStop(rig)

    rig.notify('thread/status/changed', { threadId: 'thread-child', status: { type: 'idle' } })

    expect(await settledWithin(stopping)).toBe('held')
    rig.turns.start()
    expect(await settledWithin(stopping)).toEqual({ cancelled: true })
  })

  it('stops nothing when the child exits', async () => {
    const rig = await codexTurnLifecycleRig()
    const { stopping } = await waitingStop(rig)

    rig.codex.connections[0]!.handlers.onExit?.(new Error('codex app-server exited'))

    expect(await settledWithin(stopping)).toEqual(REFUSED)
    expect(rig.interrupts()).toEqual([])
  })

  it('stops nothing once its bound runs out', async () => {
    const rig = await codexTurnLifecycleRig()
    await answeredColdSend(rig)
    vi.useFakeTimers()
    let outcome: unknown = 'held'
    void stop(rig).then((value) => {
      outcome = value
    })

    await vi.advanceTimersByTimeAsync(CODEX_TURN_OPEN_WAIT_MS - 1)
    expect(outcome).toBe('held')
    await vi.advanceTimersByTimeAsync(1)

    expect(outcome).toEqual(REFUSED)
    expect(rig.interrupts()).toEqual([])
  })
})

// What a host stop reads, in its own step and with no wait, to judge whether it ends work.
describe("Codex's live view of what its child has in flight", () => {
  const liveWork = (rig: Rig) => rig.adapter.liveWork('session-1')

  it('is nothing at rest', async () => {
    const rig = await codexTurnLifecycleRig()

    expect(liveWork(rig)).toBeUndefined()
  })

  it('is a send with no turn yet from the answer until its turn opens, then that turn', async () => {
    const rig = await codexTurnLifecycleRig()
    await answeredColdSend(rig)

    expect(liveWork(rig)).toEqual({ turnId: null })
    rig.turns.start()
    expect(liveWork(rig)).toEqual({ turnId: 'turn-1' })
  })

  // Codex carries a command out as a turn of its own, whose rows join the command's turn.
  it("names a turn carrying a command by the command's journal turn", () => {
    const work = codexLiveWork({
      threadId: CODEX_TEST_THREAD_ID,
      activeTurnIds: new Set(['provider-turn']),
      dispatchEchoes: { answeredUnopenedTurn: () => null },
      translator: {
        commandJournalTurnId: (turnId) => (turnId === 'provider-turn' ? 'command-turn' : turnId)
      }
    })

    expect(work).toEqual({ turnId: 'command-turn' })
  })

  it('is nothing once the turn ends', async () => {
    const rig = await codexTurnLifecycleRig()
    await answeredColdSend(rig)
    rig.turns.start()

    rig.turns.end('completed')

    expect(liveWork(rig)).toBeUndefined()
  })

  it('is nothing once the answered turn ends without opening', async () => {
    const rig = await codexTurnLifecycleRig()
    await answeredColdSend(rig)

    rig.turns.end('interrupted')

    expect(liveWork(rig)).toBeUndefined()
  })
})
