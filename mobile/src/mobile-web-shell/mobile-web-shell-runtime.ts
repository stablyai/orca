import * as ExpoCrypto from 'expo-crypto'
import { encodeBase64Url } from '../transport/mobile-endpoint-supervisor-support'
import { BRIDGE_READY_RETRY_MAX_MS } from './bridge/bridge-client-init-handshake'
import type { GenerationStore } from './generation-store'
import { processGenerationStore } from './process-generation-store'

/**
 * Everything the shell session touches that a test cannot: entropy, the clock, the filesystem.
 *
 * It lives beside the hook rather than inside it so the suite can drive all three without a
 * simulator, and so the one number the shell waits on has somewhere honest to be stated.
 */

/** 32 bytes, base64url: the session id scopes the view's private origin, so two mounts must never
 *  share one and a remount must never reuse the one that was just on screen. */
const SESSION_ID_BYTES = 32

/**
 * How long a finished document has to say `ready` before the shell gives up on it.
 *
 * Five times the page's own 2 s retry ceiling (`BRIDGE_READY_RETRY_MAX_MS`), so no device is slow
 * enough for the backoff to outlast the wait: whatever the page is doing, several of its asks fit
 * inside this. What it bounds is a page that will never ask at all, because a route module threw
 * while the bundle was being evaluated and nothing downstream of that import ever ran.
 */
export const PAGE_READY_DEADLINE_MS = BRIDGE_READY_RETRY_MAX_MS * 5

export type MobileWebShellRuntime = {
  createStore(): GenerationStore
  mintSessionId(): string
  now(): number
  /** Runs `run` once, `delayMs` from now, and returns the cancel. The seam the deadline test drives
   *  instead of waiting ten seconds for a real one. */
  setTimer(run: () => void, delayMs: number): () => void
}

export function createMobileWebShellRuntime(): MobileWebShellRuntime {
  return {
    createStore: processGenerationStore,
    mintSessionId: () => encodeBase64Url(ExpoCrypto.getRandomBytes(SESSION_ID_BYTES)),
    now: Date.now,
    setTimer: (run, delayMs) => {
      const handle = setTimeout(run, delayMs)
      return () => clearTimeout(handle)
    }
  }
}
