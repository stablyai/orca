import * as ExpoCrypto from 'expo-crypto'
import { encodeBase64Url } from '../transport/mobile-endpoint-supervisor-support'
import { BRIDGE_READY_RETRY_MAX_MS } from './bridge/bridge-client-init-handshake'
import type { GenerationStore } from './generation-store'
import { processGenerationStore } from './process-generation-store'
import { setForegroundTimer } from './foreground-timer'

// Use 32 random base64url bytes: each mount/remount needs a fresh id for the view’s private origin.
const SESSION_ID_BYTES = 32

// Allow five ready-backoff ceilings before treating a loaded document as silent; startup import failures may prevent every ready attempt.
export const PAGE_READY_DEADLINE_MS = BRIDGE_READY_RETRY_MAX_MS * 5

// Bound local loads the WebView refuses or never commits.
export const DOCUMENT_LOAD_DEADLINE_MS = 20_000

export type MobileWebShellRuntime = {
  createStore(): GenerationStore
  mintSessionId(): string
  now(): number
  // Count only foreground time and return cancellation; tests replace this seam instead of waiting on wall time.
  setForegroundTimer(run: () => void, delayMs: number): () => void
}

export function createMobileWebShellRuntime(): MobileWebShellRuntime {
  return {
    createStore: processGenerationStore,
    mintSessionId: () => encodeBase64Url(ExpoCrypto.getRandomBytes(SESSION_ID_BYTES)),
    now: Date.now,
    setForegroundTimer
  }
}
