// Models Codex 0.157 turn_processor.rs and bespoke_event_handling.rs ordering, with pre-0.148 reply mode.

import { CodexAppServerRequestError } from './codex-app-server-connection'

type Notify = (method: string, params: unknown) => void

export type CodexTurnLifecycleFake = {
  routes: {
    'turn/start': () => unknown
    'turn/steer': (params: Record<string, unknown> | undefined) => unknown
    'turn/interrupt': (params: Record<string, unknown> | undefined) => unknown
  }
  holdNextAnswer: () => () => void
  start: () => void
  /** Enable interruption before turn/started is read; that frame then precedes the reply. */
  run: () => void
  /** Clear active state at interrupt receipt; end() sends completion later. */
  takeInterrupt: () => string
  end: (status: 'completed' | 'interrupted' | 'failed', errorMessage?: string) => void
  /** Pre-0.148 unopened failures report an error without turn/completed. */
  failUnopened: (message: string) => void
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
  let aborting: string | null = null
  const finish = (turnId: string, status: string, errorMessage?: string): void => {
    // Completing an aborted turn must preserve any replacement turn.
    if (aborting === turnId) {
      aborting = null
    } else {
      picked = null
      active = null
      pickedRuns = false
    }
    // Codex reports idle before turn completion.
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
        // Pre-0.148 steered starts return a submission ID that never becomes a turn.
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
        // Completion follows the interrupt reply on a later read unless already delivered.
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
      // An interrupted turn completes before its replacement.
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
