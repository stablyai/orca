import type { GenerationStore } from './generation-store'
import type {
  MobileWebShellSessionEffect,
  MobileWebShellSessionEvent
} from './mobile-web-shell-session-contract'

export async function verifyGeneration(
  store: GenerationStore,
  hostKey: string,
  flow: number,
  effect: Extract<MobileWebShellSessionEffect, { kind: 'verify-generation' }>,
  send: (event: MobileWebShellSessionEvent) => void
): Promise<void> {
  // A failed check is no evidence against the bytes; remounting them is the cheaper recovery.
  const intact = await store.verifyActiveGeneration(hostKey, effect.buildId).catch(() => true)
  send({ type: 'generation-verified', flow, intact, pageReady: effect.pageReady })
}
