export type MobileStructuredPaginationState = {
  phase: 'ready' | 'loading' | 'settling' | 'latched'
  userMomentum: boolean
  programmaticMomentum: boolean
}

export function createMobileStructuredPaginationState(): MobileStructuredPaginationState {
  return { phase: 'ready', userMomentum: false, programmaticMomentum: false }
}

export function beginStructuredUserScroll(state: MobileStructuredPaginationState): void {
  state.userMomentum = true
  state.programmaticMomentum = false
  if (state.phase === 'latched') {
    state.phase = 'ready'
  }
}

export function admitStructuredOlderPage(state: MobileStructuredPaginationState): boolean {
  if (state.phase !== 'ready' || !state.userMomentum || state.programmaticMomentum) {
    return false
  }
  state.phase = 'loading'
  state.userMomentum = false
  return true
}

export function settleStructuredOlderPage(state: MobileStructuredPaginationState): void {
  state.phase = 'latched'
  state.programmaticMomentum = false
}

export function finishStructuredPaginationMomentum(
  state: MobileStructuredPaginationState,
  userOwned: boolean
): void {
  if (!userOwned && state.programmaticMomentum) {
    state.programmaticMomentum = false
    state.phase = 'latched'
    return
  }
  state.userMomentum = false
  state.phase = 'latched'
}
