import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { PtyProbeOptions } from './types'

export async function getSshPtyForegroundProcess(
  mux: SshChannelMultiplexer,
  relayPtyId: string,
  options?: PtyProbeOptions
): Promise<string | null> {
  const requestOptions =
    options?.deadlineMs === undefined && !options?.signal
      ? undefined
      : {
          signal: options.signal,
          ...(options.deadlineMs === undefined
            ? {}
            : { timeoutMs: Math.max(1, options.deadlineMs - Date.now()) })
        }
  const params = { id: relayPtyId }
  const result = requestOptions
    ? await mux.request('pty.getForegroundProcess', params, requestOptions)
    : await mux.request('pty.getForegroundProcess', params)
  return result as string | null
}
