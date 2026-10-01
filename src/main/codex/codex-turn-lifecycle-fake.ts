// Codex 0.157's turn bookkeeping as `turn/start` and `turn/interrupt` see it, for
// tests. From app-server `turn_processor.rs`: `turn/start` picks the turn before it
// answers, a send while a turn is open is steered into it under the same id with no
// second `turn/started`, and `turn_interrupt_inner` refuses with -32600 until the
// turn has started. The answer can be held, so a test can deliver it after the
// turn's own frames, as the wire allows.

import { CodexAppServerRequestError } from './codex-app-server-connection'

type Notify = (method: string, params: unknown) => void

export type CodexTurnLifecycleFake = {
  routes: {
    'turn/start': () => unknown
    'turn/interrupt': (params: Record<string, unknown> | undefined) => unknown
  }
  /** The next `turn/start` answer waits until the returned release runs. */
  holdNextAnswer: () => () => void
  /** Codex emits `turn/started` for the turn it picked last. */
  start: () => void
  /** Codex ends the picked or running turn on its own. */
  end: (status: 'completed' | 'interrupted' | 'failed', errorMessage?: string) => void
  /** Codex echoes a user message it recorded in the current turn. */
  echo: (clientId: string) => void
  readonly turnId: string | null
}

function refusal(message: string): CodexAppServerRequestError {
  return new CodexAppServerRequestError(
    'turn/interrupt',
    -32600,
    `codex app-server turn/interrupt failed: ${message}`,
    message
  )
}

export function codexTurnLifecycleFake(
  threadId: string,
  notify: () => Notify
): CodexTurnLifecycleFake {
  let minted = 0
  let echoes = 0
  let picked: string | null = null
  let active: string | null = null
  let lastTurn: string | null = null
  let held: Promise<void> | null = null
  const finish = (turnId: string, status: string, errorMessage?: string): void => {
    picked = null
    active = null
    notify()('turn/completed', {
      threadId,
      turn: { id: turnId, status, ...(errorMessage ? { error: { message: errorMessage } } : {}) }
    })
  }
  return {
    routes: {
      'turn/start': () => {
        const turnId = active ?? picked ?? `turn-${++minted}`
        picked ??= active ? null : turnId
        lastTurn = turnId
        const answer = { turn: { id: turnId, status: 'inProgress' } }
        const wait = held
        held = null
        return wait ? wait.then(() => answer) : answer
      },
      'turn/interrupt': (params) => {
        const turnId = params?.turnId
        if (!active) {
          throw refusal('no active turn to interrupt')
        }
        if (active !== turnId) {
          throw refusal(`expected active turn id ${String(turnId)} but found ${active}`)
        }
        // Codex answers the interrupt once the turn has aborted.
        finish(active, 'interrupted')
        return {}
      }
    },
    holdNextAnswer: () => {
      let release!: () => void
      held = new Promise<void>((resolve) => {
        release = resolve
      })
      return () => release()
    },
    start: () => {
      if (!picked) {
        throw new Error('no picked turn to start')
      }
      active = picked
      notify()('turn/started', { threadId, turn: { id: active, status: 'inProgress' } })
    },
    end: (status, errorMessage) => {
      const turnId = active ?? picked
      if (!turnId) {
        throw new Error('no turn to end')
      }
      finish(turnId, status, errorMessage)
    },
    echo: (clientId) => {
      const turnId = active ?? picked ?? lastTurn
      notify()('item/completed', {
        threadId,
        turn: { id: turnId },
        item: { type: 'userMessage', id: `item-user-${++echoes}`, clientId, content: [] }
      })
    },
    get turnId() {
      return active ?? picked
    }
  }
}
