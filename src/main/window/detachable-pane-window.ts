/** Lifecycle states for a pane that can move between the main window and a child window. */
export const detachablePaneWindowStates = [
  'attached',
  'transferring',
  'detached',
  'reintegrating',
  'parked'
] as const

export type DetachablePaneWindowState = (typeof detachablePaneWindowStates)[number]

/** Only these state changes are valid for a detachable pane window. */
export const detachablePaneWindowTransitions = {
  attached: ['transferring'],
  transferring: ['attached', 'detached'],
  detached: ['reintegrating', 'parked'],
  reintegrating: ['attached', 'parked'],
  parked: ['reintegrating']
} as const satisfies Record<DetachablePaneWindowState, readonly DetachablePaneWindowState[]>

export type DetachablePaneWindowTransition = {
  [State in DetachablePaneWindowState]: {
    from: State
    to: (typeof detachablePaneWindowTransitions)[State][number]
  }
}[DetachablePaneWindowState]

export class InvalidDetachablePaneWindowTransitionError extends Error {
  readonly from: DetachablePaneWindowState
  readonly to: DetachablePaneWindowState

  constructor(from: DetachablePaneWindowState, to: DetachablePaneWindowState) {
    super(`Invalid detachable pane window transition: ${from} -> ${to}`)
    this.name = 'InvalidDetachablePaneWindowTransitionError'
    this.from = from
    this.to = to
  }
}

export function canTransitionDetachablePaneWindow(
  from: DetachablePaneWindowState,
  to: DetachablePaneWindowState
): to is DetachablePaneWindowTransition['to'] {
  return detachablePaneWindowTransitions[from].some((state) => state === to)
}

export function transitionDetachablePaneWindow(
  from: DetachablePaneWindowState,
  to: DetachablePaneWindowState
): DetachablePaneWindowState {
  if (!canTransitionDetachablePaneWindow(from, to)) {
    throw new InvalidDetachablePaneWindowTransitionError(from, to)
  }
  return to
}

/** Small main-process state holder for callers that need lifecycle enforcement. */
export class DetachablePaneWindowLifecycle {
  #state: DetachablePaneWindowState

  constructor(initialState: DetachablePaneWindowState = 'attached') {
    this.#state = initialState
  }

  get state(): DetachablePaneWindowState {
    return this.#state
  }

  transition(to: DetachablePaneWindowState): DetachablePaneWindowState {
    this.#state = transitionDetachablePaneWindow(this.#state, to)
    return this.#state
  }
}
