import type { BrowserSetGrabModeResult } from '../../../shared/browser/element-grab/browser-grab-types'
import type { GrabDocumentScope } from './grab-document-scope'

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

/** `onAdmitted` runs synchronously only for an accepted request, so a refusal publishes nothing. */
export function queueGrabModeOperation(
  browserPageId: string,
  operation: GrabModeRequest['run'],
  onAdmitted: () => void = () => {}
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
  onAdmitted()
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

export type GrabModeOwner = {
  requestId?: string
  identity: string
  scope?: GrabDocumentScope
  /** Only a completed enable grants selection; a failed or disabling request never does. */
  armed: boolean
}
// Leaf state, so page teardown in the browser manager can dispose it without importing the sequencer.
export const grabModeOwners = new Map<string, GrabModeOwner>()
export const grabModeIntents = new Map<string, { enabled: boolean }>()

/** Every page teardown (close, guest destroyed, wait gave up) drops the page's mode owner and queued work. */
export function disposeGrabModeStateForPage(browserPageId: string): void {
  grabModeOwners.delete(browserPageId)
  grabModeIntents.delete(browserPageId)
  const state = grabModeOperationByPageId.get(browserPageId)
  if (state) {
    retireGrabModeAdmission(state)
  }
  grabModeOperationByPageId.delete(browserPageId)
}

export function resetGrabModeState(): void {
  grabModeOwners.clear()
  grabModeIntents.clear()
  for (const state of grabModeOperationByPageId.values()) {
    retireGrabModeAdmission(state)
  }
  grabModeOperationByPageId.clear()
}
