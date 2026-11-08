import { abortSignalReason } from '../../shared/abort-signal-reason'
import type { AcpStructuredConnection } from './acp-structured-connection'
import type { AcpOptionWrite, AcpStructuredOptions } from './acp-structured-options'

export type AcpOptionWriteBound = {
  agent: string
  timeoutMs: number
  signal?: AbortSignal
  onUncertain?: (error: Error) => void
}

export function writeAcpSessionOption(
  connection: Pick<AcpStructuredConnection, 'setConfigOption' | 'setModel'>,
  options: AcpStructuredOptions,
  write: AcpOptionWrite,
  bound: AcpOptionWriteBound & { key: string; value: string }
): Promise<void> {
  return boundAcpOptionWrite(options, bound, () =>
    write.method === 'config'
      ? connection
          .setConfigOption(write.configId, write.value)
          .then((result) => () => options.adoptConfigOptions(result.configOptions))
      : connection.setModel(write.modelId).then(() => () => options.adoptModel(write.modelId))
  )
}

/** Only the current, still-awaited write may establish reusable option proof. */
export function boundAcpOptionWrite(
  options: AcpStructuredOptions,
  bound: AcpOptionWriteBound & { key: string; value: string },
  /** Resolves to the proof's adoption; a returned model marks selector proof. */
  send: () => Promise<() => string | void>
): Promise<void> {
  const { agent, timeoutMs, signal } = bound
  if (signal?.aborted) {
    return Promise.reject(abortSignalReason(signal))
  }
  const revision = ++options.writeRevision
  options.invalidateInput(bound.key)
  options.writing += 1
  let completed = false
  const applied = send().then((apply) => {
    completed = true
    if (options.writeRevision !== revision) {
      throw new Error(`${agent} option write was superseded`)
    }
    const resolved = apply()
    options.adoptOwnWrite(bound.key, bound.value, resolved ?? undefined)
  })
  void applied.catch(() => {
    completed = true
  })
  return new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => {
      if (options.writeRevision === revision) {
        options.writeRevision += 1
      }
      settle()
      // A local deadline/abort cannot cancel an already-sent native control.
      if (!completed) {
        bound.onUncertain?.(error)
      }
      reject(error)
    }
    const onAbort = (): void => {
      if (signal) {
        fail(abortSignalReason(signal))
      }
    }
    const timer = setTimeout(
      () => fail(new Error(`${agent} did not answer an option write within ${timeoutMs}ms`)),
      timeoutMs
    )
    let settled = false
    const settle = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      options.writing -= 1
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    applied.then(() => {
      settle()
      resolve()
    }, fail)
  })
}
