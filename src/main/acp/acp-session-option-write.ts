import { abortSignalReason } from '../../shared/abort-signal-reason'
import type { AcpStructuredConnection } from './acp-structured-connection'
import type { AcpOptionWrite, AcpStructuredOptions } from './acp-structured-options'

/** Only the current, still-awaited write may establish reusable option proof. */
export function writeAcpSessionOption(
  connection: Pick<AcpStructuredConnection, 'setConfigOption' | 'setModel'>,
  options: AcpStructuredOptions,
  write: AcpOptionWrite,
  bound: { agent: string; timeoutMs: number; signal?: AbortSignal; key: string; value: string }
): Promise<void> {
  const { agent, timeoutMs, signal } = bound
  if (signal?.aborted) {
    return Promise.reject(abortSignalReason(signal))
  }
  const revision = ++options.writeRevision
  options.invalidateInput(bound.key)
  const adopt = (apply: () => void): void => {
    if (options.writeRevision !== revision) {
      throw new Error(`${agent} option write was superseded`)
    }
    apply()
    options.appliedInput.set(bound.key, write.method === 'config' ? write.value : write.modelId)
  }
  const applied =
    write.method === 'config'
      ? connection
          .setConfigOption(write.configId, write.value)
          .then((result) => adopt(() => options.adoptConfigOptions(result.configOptions)))
      : connection
          .setModel(write.modelId)
          .then(() => adopt(() => options.adoptModel(write.modelId)))
  return new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => {
      if (options.writeRevision === revision) {
        options.writeRevision += 1
      }
      settle()
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
    const settle = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    applied.then(() => {
      settle()
      resolve()
    }, fail)
  })
}
