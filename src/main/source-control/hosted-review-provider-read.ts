import { AsyncLocalStorage } from 'node:async_hooks'

type ProviderRead = { answeredFromProviderCache: boolean }

const currentRead = new AsyncLocalStorage<ProviderRead>()

/** Runs one hosted-review provider read and reports whether a provider-internal cache answered it, so that answer is never taken as a fresh read. */
export async function observeProviderRead<T>(
  read: () => Promise<T>
): Promise<{ value: T; answeredFromProviderCache: boolean }> {
  const observation: ProviderRead = { answeredFromProviderCache: false }
  const value = await currentRead.run(observation, read)
  return { value, answeredFromProviderCache: observation.answeredFromProviderCache }
}

/** Provider caches call this when they answer with work that began before the current read. */
export function noteProviderCacheAnswer(): void {
  const observation = currentRead.getStore()
  if (observation) {
    observation.answeredFromProviderCache = true
  }
}
