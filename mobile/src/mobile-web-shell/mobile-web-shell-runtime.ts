import { BRIDGE_READY_RETRY_MAX_MS } from './bridge/bridge-client-init-handshake'
import type { GenerationStore } from './generation-store'
import { processGenerationStore } from './process-generation-store'
import { setForegroundTimer } from './foreground-timer'
import { claimHomeSparePage } from './home-spare-page'
import { mintShellSessionId } from './shell-session-id'

// Allow five ready-backoff ceilings before treating a loaded document as silent; startup import failures may prevent every ready attempt.
export const PAGE_READY_DEADLINE_MS = BRIDGE_READY_RETRY_MAX_MS * 5

// Bound local loads the WebView refuses or never commits.
export const DOCUMENT_LOAD_DEADLINE_MS = 20_000

export type MobileWebShellRuntime = {
  createStore(): GenerationStore
  mintSessionId(): string
  // The session id of a page Home booted from this directory, so the view adopts it instead of a new one.
  claimSpareSessionId(directory: string): Promise<string | null>
  now(): number
  // Count only foreground time and return cancellation; tests replace this seam instead of waiting on wall time.
  setForegroundTimer(run: () => void, delayMs: number): () => void
}

export function createMobileWebShellRuntime(): MobileWebShellRuntime {
  return {
    createStore: processGenerationStore,
    mintSessionId: mintShellSessionId,
    claimSpareSessionId: claimHomeSparePage,
    now: Date.now,
    setForegroundTimer
  }
}
