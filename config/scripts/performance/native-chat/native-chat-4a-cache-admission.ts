import type { OutlineCacheState } from './native-chat-4a-source-observer'

export const outlineSourceKey = (state: OutlineCacheState): string =>
  JSON.stringify([state.epoch, state.sequence, state.revision])

/** Admission is optional; only a real persisted matching row ends this bounded retry. */
export async function admitOutline(input: {
  observe: () => OutlineCacheState
  request: (before: OutlineCacheState) => Promise<void>
  record: (state: OutlineCacheState) => void
  timeoutMs?: number
}): Promise<OutlineCacheState> {
  const deadline = Date.now() + (input.timeoutMs ?? 30_000)
  do {
    const state = input.observe()
    input.record(state)
    if (state.matchesSource) {
      return state
    }
    if (state.eligible) {
      await input.request(state)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  throw new Error('optional outline admission not observed; cache sample unexercised')
}
