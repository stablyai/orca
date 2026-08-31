export type ClaudeOwnedTurnLifecycle = {
  register: (sessionId: string, turnId: string, sequence: number) => void
  confirm: (turnId: string) => void
  settle: (turnId: string) => void
  end: () => void
  dispose: () => void
}

type OwnedTurn = {
  sessionId: string
  turnId: string
  sequence: number
  state: 'provisional' | 'confirmed' | 'abandoned' | 'settled'
}

export function createClaudeOwnedTurnLifecycle(
  publish: (sessionId: string, turnId: string, running: boolean) => void
): ClaudeOwnedTurnLifecycle & { abandon: (turnId: string) => void } {
  const turns = new Map<string, OwnedTurn>()
  let terminal = false

  const settle = (turnId: string): void => {
    const turn = turns.get(turnId)
    if (!turn || turn.state === 'settled') {
      return
    }
    const published = turn.state === 'confirmed'
    turn.state = 'settled'
    if (published) {
      publish(turn.sessionId, turn.turnId, false)
    }
  }

  return {
    register: (sessionId, turnId, sequence) => {
      if (!terminal && !turns.has(turnId)) {
        turns.set(turnId, { sessionId, turnId, sequence, state: 'provisional' })
      }
    },
    confirm: (turnId) => {
      if (terminal) {
        return
      }
      const turn = turns.get(turnId)
      if (!turn || turn.state === 'confirmed' || turn.state === 'settled') {
        return
      }
      turn.state = 'confirmed'
      publish(turn.sessionId, turn.turnId, true)
    },
    settle: (turnId) => {
      if (!terminal) {
        settle(turnId)
      }
    },
    abandon: (turnId) => {
      if (terminal) {
        return
      }
      const turn = turns.get(turnId)
      if (turn?.state === 'provisional') {
        turn.state = 'abandoned'
      }
    },
    end: () => {
      if (terminal) {
        return
      }
      for (const turn of turns.values()) {
        if (turn.state === 'confirmed') {
          publish(turn.sessionId, turn.turnId, false)
        }
        turn.state = 'settled'
      }
      terminal = true
    },
    dispose: () => {
      terminal = true
      turns.clear()
    }
  }
}
