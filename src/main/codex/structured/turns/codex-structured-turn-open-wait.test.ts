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
const MAY_OPEN = { cancelled: false, refusal: { turnMayOpen: true } }

const stop = (rig: Rig) => rig.adapter.cancelTurn({ sessionId: 'session-1', fence: 7 })

async function answeredColdSend(rig: Rig): Promise<void> {
  const sending = rig.send('client-1')
  expect(await settledWithin(sending)).toMatchObject(ADMITTED)
  expect(rig.turns.turnId).toBe('turn-1')
}

const interruptedTurns = (rig: Rig) => rig.interrupts().map((call) => call.params?.turnId)

function pressed(rig: Rig): () => unknown {
  let outcome: unknown = 'held'
  void stop(rig).then((value) => {
    outcome = value
  })
  return () => outcome
}

async function waitingStop(rig: Rig) {
  await answeredColdSend(rig)
  const stopping = stop(rig)
  expect(await settledWithin(stopping)).toBe('held')
  expect(interruptedTurns(rig)).toEqual(['turn-1'])
  // Wrap the pending promise to avoid async return awaiting it.
  return { stopping }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("a no-turn Stop in the window between Codex's answer and its turn opening", () => {
  it.each(['expiry', 'retry', 'replacement'])(
    'spends only the remaining Stop allowance after a late refusal: %s',
    async (mode) => {
      const rig = await codexTurnLifecycleRig()
      await answeredColdSend(rig)
      const request = vi.spyOn(rig.adapter['sessions'].get('session-1')!.connection, 'request')
      const interrupt = rig.codex.routes['turn/interrupt']!
      let first = true
      rig.codex.routes['turn/interrupt'] = async (params) => {
        if (!first) {
          return interrupt(params)
        }
        first = false
        await new Promise((resolve) => setTimeout(resolve, 4_900))
        try {
          return interrupt(params)
        } finally {
          if (mode === 'replacement') {
            rig.turns.start()
            rig.adapter['sessions'].delete('session-1')
          }
        }
      }
      vi.useFakeTimers()
      const stopping = stop(rig)
      if (mode === 'retry') {
        setTimeout(() => rig.turns.start(), 4_950)
      }
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await stopping).toEqual(
        mode === 'retry'
          ? { cancelled: true, turnId: 'turn-1' }
          : mode === 'expiry'
            ? MAY_OPEN
            : REFUSED
      )
      if (mode === 'expiry') {
        rig.turns.start()
      }
      await vi.advanceTimersByTimeAsync(0)
      expect(interruptedTurns(rig)).toEqual(mode === 'retry' ? ['turn-1', 'turn-1'] : ['turn-1'])
      expect(
        request.mock.calls
          .filter(([method]) => method === 'turn/interrupt')
          .map((call) => call[2]?.timeoutMs)
      ).toEqual(mode === 'retry' ? [5_000, 50] : [5_000])
    }
  )

  it('refused before the thread runs, waits for the turn to open and interrupts once more', async () => {
    const rig = await codexTurnLifecycleRig()
    const { stopping } = await waitingStop(rig)

    rig.turns.start()

    expect(await settledWithin(stopping)).toEqual({ cancelled: true, turnId: 'turn-1' })
    expect(interruptedTurns(rig)).toEqual(['turn-1', 'turn-1'])
    await vi.waitFor(() => expect(rig.turns.turnId).toBeNull())
  })

  it('stops nothing when the turn ends without opening', async () => {
    const rig = await codexTurnLifecycleRig()
    const { stopping } = await waitingStop(rig)

    rig.turns.end('interrupted')

    expect(await settledWithin(stopping)).toEqual(REFUSED)
    expect(interruptedTurns(rig)).toEqual(['turn-1'])
  })

  // Thread idle alone does not settle an owed send's unopened turn.
  it.each(['idle', 'systemError'])(
    'answers refused, on the first press and on a second alike, when Codex reports the thread %s',
    async (type) => {
      const rig = await codexTurnLifecycleRig()
      const { stopping } = await waitingStop(rig)

      rig.notify('thread/status/changed', { threadId: CODEX_TEST_THREAD_ID, status: { type } })

      expect(await settledWithin(stopping)).toEqual(MAY_OPEN)
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

  // A timed-out turn may still run; host cancellation must close the child.

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
})
