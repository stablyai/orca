import type { BrowserPanePaintVerdict } from '../../shared/runtime-types'

export type BrowserPanePaintObservation = {
  verdict: BrowserPanePaintVerdict
  observedAt: string | null
}

// Why: a probe that never ran is not a negative verdict. Anything that could not capture — no
// guest, a hidden window, or a return that precedes navigation — reports this instead of `false`.
export const UNOBSERVED_PANE_PAINT: BrowserPanePaintObservation = Object.freeze({
  verdict: 'unobserved',
  observedAt: null
})

/** Only a capture that actually completed produces a verdict, and a verdict always carries its time. */
export function observedPanePaint(painted: boolean): BrowserPanePaintObservation {
  return { verdict: painted ? 'painted' : 'unpainted', observedAt: new Date().toISOString() }
}
