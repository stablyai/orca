import type { RuntimeAgentPromptWriteOptions } from './agent-prompt-write-options'
export function assertAgentPromptRequestActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('request_aborted')
  }
}

export async function waitForAgentPromptPromise<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) {
    return await promise
  }
  assertAgentPromptRequestActive(signal)
  return await new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (result: { value: T } | { error: unknown }): void => {
      if (settled) {
        return
      }
      settled = true
      signal.removeEventListener('abort', onAbort)
      if ('error' in result) {
        reject(result.error)
      } else {
        resolve(result.value)
      }
    }
    const onAbort = (): void => finish({ error: new Error('request_aborted') })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    promise.then(
      (value) => finish({ value }),
      (error: unknown) => finish({ error })
    )
  })
}

export async function waitForAgentPromptDelay(
  delayMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    return
  }
  assertAgentPromptRequestActive(signal)
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('request_aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
    }
  })
}

export function agentPromptObservationSignal(
  options: RuntimeAgentPromptWriteOptions
): AbortSignal | undefined {
  return options.signal && options.observationSignal
    ? AbortSignal.any([options.signal, options.observationSignal])
    : (options.signal ?? options.observationSignal)
}
