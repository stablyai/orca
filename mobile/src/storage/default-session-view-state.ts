import type { MobileSessionView } from './session-view-preferences'

/**
 * The per-device default view; `settled` is false only until the first read answers.
 * `hasStoredValue` is false while the user never chose one (`value` is then the built-in default).
 */
export type DefaultSessionViewState = {
  value: MobileSessionView
  settled: boolean
  hasStoredValue: boolean
}

// Why its own module: launch builders read it synchronously without loading device storage.
let state: DefaultSessionViewState | null = null

export function readDefaultSessionViewState(): DefaultSessionViewState | null {
  return state
}

export function writeDefaultSessionViewState(next: DefaultSessionViewState | null): void {
  state = next
}

/**
 * The view this phone asks for on a launch: its settled default. Nothing before it loads or while
 * the user never chose one, so the host's own default decides.
 */
export function settledLaunchSessionView(): MobileSessionView | undefined {
  return state?.settled && state.hasStoredValue ? state.value : undefined
}
