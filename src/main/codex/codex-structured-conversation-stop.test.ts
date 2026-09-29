// A Codex Stop that names no turn. The fake keeps Codex 0.157's turn bookkeeping: it answers
// `turn/start` before it opens the turn, and refuses an interrupt until then.

import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_TEST_THREAD_ID,
  codexTurnLifecycleRig
} from './codex-structured-dispatch-test-support'

type Rig = Awaited<ReturnType<typeof codexTurnLifecycleRig>>

async function openedTurn(rig: Rig): Promise<void> {
  const sending = rig.send('client-1')
  await vi.waitFor(() => expect(rig.turns.turnId).toBe('turn-1'))
  rig.turns.start()
  await sending
}

const stop = (rig: Rig, resolveLiveTurnId?: () => string | null) =>
  rig.adapter.cancelTurn({
    sessionId: 'session-1',
    fence: 7,
    ...(resolveLiveTurnId ? { resolveLiveTurnId } : {})
  })

describe('a Codex Stop that names no turn', () => {
  it('interrupts the turn Codex opened when the journal shows none yet', async () => {
    const rig = await codexTurnLifecycleRig()
    await openedTurn(rig)

    await expect(stop(rig, () => null)).resolves.toEqual({ cancelled: true })
    expect(rig.interrupts().map((call) => call.params?.turnId)).toEqual(['turn-1'])
  })

  it('interrupts no turn that already ended', async () => {
    const rig = await codexTurnLifecycleRig()
    await openedTurn(rig)
    rig.turns.end('completed')

    await expect(stop(rig)).resolves.toEqual({ cancelled: false })
    expect(rig.interrupts()).toEqual([])
  })

  it("names the journal's turn over the one it saw open, and carries Codex's refusal", async () => {
    const rig = await codexTurnLifecycleRig()
    await openedTurn(rig)

    await expect(stop(rig, () => 'turn-journal')).resolves.toEqual({
      cancelled: false,
      refusal: {
        detail: {
          text: 'expected active turn id turn-journal but found turn-1',
          audience: 'person'
        }
      }
    })
    expect(rig.interrupts().map((call) => call.params?.turnId)).toEqual(['turn-journal'])
  })

  it('interrupts nothing for another fence', async () => {
    const rig = await codexTurnLifecycleRig()
    await openedTurn(rig)

    await expect(rig.adapter.cancelTurn({ sessionId: 'session-1', fence: 6 })).resolves.toEqual({
      cancelled: false
    })
    expect(rig.interrupts()).toEqual([])
  })

  it('interrupts no earlier turn while a compaction the journal shows has not started', async () => {
    const rig = await codexTurnLifecycleRig()
    await openedTurn(rig)
    rig.turns.end('completed')
    const compaction = rig.adapter.compact({
      turnId: 'compact:operation-1',
      sessionId: 'session-1',
      fence: 7
    })
    await vi.waitFor(() =>
      expect(rig.codex.connections[0]!.calls.at(-1)?.method).toBe('thread/compact/start')
    )

    await expect(stop(rig, () => 'compact:operation-1')).resolves.toEqual({ cancelled: false })
    expect(rig.interrupts()).toEqual([])

    rig.notify('turn/started', { threadId: CODEX_TEST_THREAD_ID, turn: { id: 'turn-compact' } })
    rig.notify('thread/compacted', { threadId: CODEX_TEST_THREAD_ID })
    rig.notify('turn/completed', {
      threadId: CODEX_TEST_THREAD_ID,
      turn: { id: 'turn-compact', status: 'completed' }
    })
    await expect(compaction).resolves.toEqual({ outcome: 'compacted' })
  })
})
