// Codex 0.157's turn bookkeeping as `turn/start`, `turn/steer` and `turn/interrupt` see
// it, for tests. From app-server `turn_processor.rs`: `turn/start` picks the turn before it
// answers, a send while a turn is open is steered into it under the same id with no
// second `turn/started`, `turn/steer` refuses with -32600 unless its `expectedTurnId` is
// the running turn, and `turn_interrupt_inner`, with no turn active, refuses with -32600 "no
// active turn to interrupt" until the thread runs (`run`, or `start`) and once the turn has ended.
// An interrupt Codex takes is answered before its turn ends: on `TurnAborted`,
// `bespoke_event_handling.rs` answers pending interrupts, then sends `turn/completed`
// (interrupted) on the same channel; here that end comes on a later read. The `turn/start`
// answer can be held, so a test can deliver it after the turn's own frames, as the wire
// allows. `legacyStartAnswers` is a Codex before 0.148,
// whose `turn/start` answers a steered send with its submission id, a turn that never opens,
// and whose `turn/steer` finds no turn to steer until the picked one has started.

import { CodexAppServerRequestError } from './codex-app-server-connection'

type Notify = (method: string, params: unknown) => void

export type CodexTurnLifecycleFake = {
  routes: {
    'turn/start': () => unknown
    'turn/steer': (params: Record<string, unknown> | undefined) => unknown
    'turn/interrupt': (params: Record<string, unknown> | undefined) => unknown
  }
  /** The next `turn/start` answer waits until the returned release runs. */
  holdNextAnswer: () => () => void
  /** Codex emits `turn/started` for the turn it picked last. */
  start: () => void
  /** The thread runs the picked turn, whose `turn/started` has yet to be read: an interrupt of it
   *  is taken, and that `turn/started` comes ahead of the answer. */
  run: () => void
  /** Codex takes an interrupt of the running turn: it drops it as its active turn before it
   *  answers, and that turn's `turn/completed` comes later (`end`). */
  takeInterrupt: () => string
  /** Codex ends the picked or running turn on its own, or the one whose interrupt it took. */
  end: (status: 'completed' | 'interrupted' | 'failed', errorMessage?: string) => void
  /** Codex fails the picked turn before starting it, which reports an `error` and no turn end. */
  failUnopened: (message: string) => void
  /** Codex echoes a user message it recorded in the current turn. */
  echo: (clientId: string) => void
  readonly turnId: string | null
}

function refusal(method: string, message: string): CodexAppServerRequestError {
  return new CodexAppServerRequestError(
    method,
    -32600,
    `codex app-server ${method} failed: ${message}`,
    message
  )
}

export function codexTurnLifecycleFake(
  threadId: string,
  notify: () => Notify,
  options: { legacyStartAnswers?: boolean } = {}
): CodexTurnLifecycleFake {
  let minted = 0
  let echoes = 0
  let picked: string | null = null
  let active: string | null = null
  let lastTurn: string | null = null
  let held: Promise<void> | null = null
  let pickedRuns = false
  // The turn whose interrupt Codex took and whose `turn/completed` is still to come.
  let aborting: string | null = null
  const finish = (turnId: string, status: string, errorMessage?: string): void => {
    // A taken interrupt's turn is no longer active: a turn picked since stays picked.
    if (aborting === turnId) {
      aborting = null
    } else {
      picked = null
      active = null
      pickedRuns = false
    }
    // As Codex does: clearing `running` publishes the thread idle ahead of the turn's end.
    notify()('thread/status/changed', { threadId, status: { type: 'idle' } })
    notify()('turn/completed', {
      threadId,
      turn: { id: turnId, status, ...(errorMessage ? { error: { message: errorMessage } } : {}) }
    })
  }

  const takeInterrupt = (): string => {
    if (!active) {
      throw new Error('no running turn to interrupt')
    }
    aborting = active
    active = null
    picked = null
    return aborting
  }
  const open = (): void => {
    if (!picked) {
      throw new Error('no picked turn to start')
    }
    active = picked
    pickedRuns = false
    notify()('turn/started', { threadId, turn: { id: active, status: 'inProgress' } })
  }
  return {
    routes: {
      'turn/start': () => {
        const running = active ?? picked
        const turnId = running ?? `turn-${++minted}`
        picked ??= active ? null : turnId
        lastTurn = turnId
        const answeredId = options.legacyStartAnswers && running ? `turn-${++minted}` : turnId
        const answer = { turn: { id: answeredId, status: 'inProgress' } }
        const wait = held
        held = null
        return wait ? wait.then(() => answer) : answer
      },
      'turn/steer': (params) => {
        const running = options.legacyStartAnswers ? active : (active ?? picked)
        if (!running) {
          throw refusal('turn/steer', 'no active turn to steer')
        }
        if (params?.expectedTurnId !== running) {
          throw refusal(
            'turn/steer',
            `expected active turn id \`${String(params?.expectedTurnId)}\` but found \`${running}\``
          )
        }
        lastTurn = running
        return { turnId: running }
      },
      'turn/interrupt': (params) => {
        const turnId = params?.turnId
        if (!active && pickedRuns && picked === turnId) {
          open()
        }
        if (!active) {
          throw refusal('turn/interrupt', 'no active turn to interrupt')
        }
        if (active !== turnId) {
          throw refusal(
            'turn/interrupt',
            `expected active turn id ${String(turnId)} but found ${active}`
          )
        }
        const aborted = takeInterrupt()
        // Answered, then the turn's end on the next read; a turn that ends meanwhile is not ended twice.
        setTimeout(() => {
          if (aborting === aborted) {
            finish(aborted, 'interrupted')
          }
        }, 0)
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
    start: () => open(),
    takeInterrupt,
    run: () => {
      if (!picked || active) {
        throw new Error('no picked turn to run')
      }
      pickedRuns = true
    },
    end: (status, errorMessage) => {
      // A taken interrupt's turn/completed comes ahead of anything a later turn sends.
      const turnId = aborting ?? active ?? picked
      if (!turnId) {
        throw new Error('no turn to end')
      }
      finish(turnId, status, errorMessage)
    },
    failUnopened: (message) => {
      if (!picked || active) {
        throw new Error('no unopened turn to fail')
      }
      const turnId = picked
      picked = null
      notify()('error', { threadId, turnId, error: { message }, willRetry: false })
      notify()('thread/status/changed', { threadId, status: { type: 'systemError' } })
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
