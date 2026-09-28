import type { IPtyProvider } from './types'

/** Source-credit generations identify transports, independently of SSH or WSL owner names. */
export const relayProvidersByGeneration = new Map<number, IPtyProvider>()

export function registerRelayPtyGeneration(generation: number, provider: IPtyProvider): () => void {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error('Invalid relay provider generation')
  }
  const existing = relayProvidersByGeneration.get(generation)
  if (existing && existing !== provider) {
    throw new Error('Relay provider generation already registered')
  }
  relayProvidersByGeneration.set(generation, provider)
  return () => {
    if (relayProvidersByGeneration.get(generation) === provider) {
      relayProvidersByGeneration.delete(generation)
    }
  }
}
