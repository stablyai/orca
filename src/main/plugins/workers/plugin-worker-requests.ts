import {
  pluginCancel,
  pluginRequest,
  type PluginEnvelope,
  type PluginErrorCode
} from '../../../shared/plugins/frames/plugin-protocol'
import type { PluginWorkerRequestError } from './plugin-host-process-types'

export type PendingCall = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export function requestError(code: PluginErrorCode, message: string): PluginWorkerRequestError {
  return Object.assign(new Error(message), { code })
}

export type PluginWorkerRequestChannel = {
  pending: Map<number, PendingCall>
  send: (message: PluginEnvelope) => void
  nextId: () => number
  isRunning: () => boolean
  tag: string
}

/** One host → worker request; a timeout or abort also cancels the worker's handler. */
export function sendPluginWorkerRequest(
  channel: PluginWorkerRequestChannel,
  method: string,
  params: unknown,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal
): Promise<unknown> {
  const { pending, send, tag } = channel
  if (!channel.isRunning()) {
    return Promise.reject(requestError('unavailable', `${tag} worker is not running`))
  }
  if (signal?.aborted) {
    return Promise.reject(requestError('cancelled', `${tag} ${label} was cancelled`))
  }
  const callId = channel.nextId()
  return new Promise<unknown>((resolve, reject) => {
    const stop = (error: PluginWorkerRequestError): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (pending.delete(callId)) {
        // Tell the handler too, so it stops instead of running on unobserved.
        send(pluginCancel(callId))
        reject(error)
      }
    }
    const onAbort = (): void => stop(requestError('cancelled', `${tag} ${label} was cancelled`))
    const timer = setTimeout(
      () => stop(requestError('timeout', `${tag} ${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    const settle =
      <T>(next: (value: T) => void) =>
      (value: T): void => {
        signal?.removeEventListener('abort', onAbort)
        next(value)
      }
    pending.set(callId, { resolve: settle(resolve), reject: settle(reject), timer })
    send(pluginRequest(callId, method, params))
  })
}
