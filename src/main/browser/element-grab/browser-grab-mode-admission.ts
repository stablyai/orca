import type { BrowserSetGrabModeResult } from '../../../shared/browser/element-grab/browser-grab-types'

type GrabModeRequest = {
  run: (signal: AbortSignal) => Promise<BrowserSetGrabModeResult>
  resolve: (result: BrowserSetGrabModeResult) => void
}
type GrabModeAdmission = { active: AbortController | null; pending: GrabModeRequest | null }
export const grabModeOperationByPageId = new Map<string, GrabModeAdmission>()
const MAX_GRAB_MODE_ADMISSIONS = 32
export const supersededGrabMode = (): BrowserSetGrabModeResult => ({
  ok: false,
  reason: 'not-ready'
})

export function retireGrabModeAdmission(state: GrabModeAdmission): void {
  state.active?.abort()
  state.pending?.resolve(supersededGrabMode())
  state.pending = null
}

export function queueGrabModeOperation(
  browserPageId: string,
  operation: GrabModeRequest['run']
): Promise<BrowserSetGrabModeResult> {
  let state = grabModeOperationByPageId.get(browserPageId)
  const created = !state
  if (!state) {
    if (grabModeOperationByPageId.size >= MAX_GRAB_MODE_ADMISSIONS) {
      return Promise.resolve(supersededGrabMode())
    }
    state = { active: null, pending: null }
    grabModeOperationByPageId.set(browserPageId, state)
  }
  retireGrabModeAdmission(state)
  const admission = state
  const result = new Promise<BrowserSetGrabModeResult>((resolve) => {
    admission.pending = { run: operation, resolve }
  })
  if (created) {
    void (async () => {
      while (admission.pending) {
        const request = admission.pending
        admission.pending = null
        const abort = new AbortController()
        admission.active = abort
        try {
          request.resolve(await request.run(abort.signal))
        } catch {
          request.resolve({ ok: false, reason: 'injection-failed' })
        } finally {
          admission.active = null
        }
      }
      if (grabModeOperationByPageId.get(browserPageId) === admission) {
        grabModeOperationByPageId.delete(browserPageId)
      }
    })()
  }
  return result
}
