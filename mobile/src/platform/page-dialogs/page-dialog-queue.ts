import {
  dialogParamsSchema,
  type BridgeDialogAnswer,
  type BridgeDialogOutcome,
  type BridgeDialogShowParams
} from '../../mobile-web-shell/bridge/native-capabilities/bridge-dialog-verb'

type Showing = {
  request: BridgeDialogShowParams
  resolve: (answer: BridgeDialogAnswer) => void
}

export type PageDialogQueue = {
  serve: (params: unknown) => Promise<unknown>
  // The dialog the shell should be presenting now, or null.
  current: () => BridgeDialogShowParams | null
  subscribe: (listener: () => void) => () => void
  answer: (token: string, outcome: BridgeDialogOutcome, value?: string) => void
  // The page left, was replaced or covered: close what it opened and answer it as dismissed.
  dismissAll: () => void
}

const DISMISSED: BridgeDialogAnswer = { outcome: 'dismiss', value: null }

// A request stays pending until the user answers, so one page can hold at most one dialog and every exit must answer it.
export function createPageDialogQueue(deps: { isFocused: () => boolean }): PageDialogQueue {
  let showing: Showing | null = null
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of listeners) {
      listener()
    }
  }
  const finish = (answer: BridgeDialogAnswer) => {
    const done = showing
    if (done === null) {
      return
    }
    showing = null
    done.resolve(answer)
    emit()
  }

  return {
    serve: async (params) => {
      const request = dialogParamsSchema.parse(params)
      if (request.action === 'dismiss') {
        const owned = showing?.request.token === request.token
        if (owned) {
          finish(DISMISSED)
        }
        return { dismissed: owned }
      }
      // The page draws its own when refused, so a second dialog never stacks over the first.
      if (showing !== null) {
        throw new Error('another dialog is already showing')
      }
      if (!deps.isFocused()) {
        throw new Error('the page is not on screen')
      }
      return new Promise<BridgeDialogAnswer>((resolve) => {
        showing = { request, resolve }
        emit()
      })
    },
    current: () => showing?.request ?? null,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    answer: (token, outcome, value) => {
      if (showing?.request.token === token) {
        finish({ outcome, value: outcome === 'confirm' ? (value ?? null) : null })
      }
    },
    dismissAll: () => finish(DISMISSED)
  }
}
