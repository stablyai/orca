import { waitForPromiseWithSignal } from '../../../src/shared/abort-signal-reason'
import type { HostPushSupportCompletion } from './host-push-registration-state'
import { getDevicePushToken } from './push-token'

export async function waitForPushFallback(
  hosts: readonly (HostPushSupportCompletion | null)[],
  signal: AbortSignal
): Promise<'no-token' | 'unsupported-host' | null> {
  const pending = new AbortController()
  const cancel = () => pending.abort()
  const signals = [signal, ...hosts.flatMap((host) => (host ? [host.signal] : []))]
  for (const source of signals) {
    source.addEventListener('abort', cancel, { once: true })
    if (source.aborted) {
      cancel()
    }
  }
  try {
    if (pending.signal.aborted) {
      return null
    }
    const answers = hosts.map((host) =>
      host ? waitForPromiseWithSignal(host.completed, pending.signal) : Promise.resolve(null)
    )
    const completed = Promise.all(answers).then(
      (values) => values.length > 0 && values.every((value) => value === false)
    )
    const unsupported = Promise.race([
      completed,
      ...answers.map(async (answer) => ((await answer) === false ? completed : false))
    ])
    const token = waitForPromiseWithSignal(getDevicePushToken(), pending.signal)
    // Only eligible evidence wins early; either negative answer must wait for the other source.
    return await Promise.race([
      token.then(async (value) =>
        value === null
          ? ('no-token' as const)
          : (await unsupported)
            ? ('unsupported-host' as const)
            : null
      ),
      unsupported.then(async (value) =>
        value
          ? ('unsupported-host' as const)
          : (await token) === null
            ? ('no-token' as const)
            : null
      )
    ])
  } catch (error) {
    if (pending.signal.aborted) {
      return null
    }
    throw error
  } finally {
    pending.abort()
    for (const source of signals) {
      source.removeEventListener('abort', cancel)
    }
  }
}
