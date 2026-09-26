// A Stop that names no turn, against the Claude adapter: the gap between writing a message and
// Claude echoing it back is exactly where no turn id exists yet, and the interrupt must still land.

import { describe, expect, it } from 'vitest'
import { acquired, fakeClaude, USER_MESSAGE } from './claude-structured-session-test-support'

function interrupts(claude: ReturnType<typeof fakeClaude>): number {
  return claude.connections[0]!.calls.filter((call) => call.subtype === 'interrupt').length
}

async function written(claude: ReturnType<typeof fakeClaude>) {
  const adapter = await acquired(claude)
  // No replay: the message is written and Claude has not opened its turn.
  await expect(
    adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })
  ).resolves.toEqual({ state: 'admitted' })
  return adapter
}

describe('Claude Stop that names no turn', () => {
  it('interrupts a written message before its turn opens', async () => {
    const claude = fakeClaude({ replayUuid: null })
    const adapter = await written(claude)

    await expect(adapter.cancelTurn({ sessionId: 'session-1', fence: 7 })).resolves.toEqual({
      cancelled: true
    })
    expect(interrupts(claude)).toBe(1)
  })

  it('still refuses the placeholder a client used to name for that gap', async () => {
    const claude = fakeClaude({ replayUuid: null })
    const adapter = await written(claude)

    await expect(
      adapter.cancelTurn({ sessionId: 'session-1', turnId: 'turn-none', fence: 7 })
    ).resolves.toEqual({ cancelled: false })
    expect(interrupts(claude)).toBe(0)
  })

  it('interrupts a turn Claude opened on its own echo', async () => {
    const claude = fakeClaude({ replayUuid: 'turn-T' })
    const adapter = await written(claude)

    await expect(adapter.cancelTurn({ sessionId: 'session-1', fence: 7 })).resolves.toEqual({
      cancelled: true
    })
    expect(interrupts(claude)).toBe(1)
  })

  it('does nothing for another fence, or with nothing in flight', async () => {
    const claude = fakeClaude({ replayUuid: null })
    const adapter = await acquired(claude)

    await expect(adapter.cancelTurn({ sessionId: 'session-1', fence: 7 })).resolves.toEqual({
      cancelled: false
    })
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })
    await expect(adapter.cancelTurn({ sessionId: 'session-1', fence: 6 })).resolves.toEqual({
      cancelled: false
    })
    expect(interrupts(claude)).toBe(0)
  })

  it('ends a turn that opens while the interrupt is on its way once, and the next send lands', async () => {
    const claude = fakeClaude({ replayUuid: null })
    const adapter = await written(claude)
    const connection = claude.connections[0]!
    // The echo that opens the turn arrives after Orca wrote the interrupt, before Claude answers it.
    claude.routes.interrupt = () => {
      connection.handlers.onMessage?.({ ...connection.sent[0]!, uuid: 'turn-late' })
      return undefined
    }

    await expect(adapter.cancelTurn({ sessionId: 'session-1', fence: 7 })).resolves.toEqual({
      cancelled: true
    })
    expect(interrupts(claude)).toBe(1)

    delete claude.routes.interrupt
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-2',
        body: USER_MESSAGE,
        fence: 7
      })
    ).resolves.toEqual({ state: 'admitted' })
    expect(connection.sent).toHaveLength(2)
  })
})
