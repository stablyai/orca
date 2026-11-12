import { abortSignalReason } from '../../../shared/abort-signal-reason'
import type { AcpStructuredConnection } from '../process/acp-structured-connection'
import type { AcpOptionWrite, AcpStructuredOptions } from './acp-structured-options'
import { AgentSessionOptionRejectedError } from '../../native-chat/agent-session-wire/options/structured-agent-session-option-error'

export type AcpOptionWriteBound = {
  agent: string
  timeoutMs: number
  signal?: AbortSignal
  onUncertain?: (error: Error) => void
}

/** A native setter carries its own call deadline, so an unanswered one fails only its send. */
export function writeAcpSessionOption(
  connection: Pick<AcpStructuredConnection, 'setConfigOption' | 'setModel' | 'prompt'>,
  options: AcpStructuredOptions,
  write: AcpOptionWrite,
  bound: AcpOptionWriteBound & { key: string; value: string }
): Promise<void> {
  const { timeoutMs } = bound
  if (write.method === 'command') {
    return boundAcpOptionWrite(options, bound, async () => {
      options.commandReply = ''
      try {
        const result = await connection.prompt([{ type: 'text', text: write.text }])
        if (result.stopReason !== 'end_turn' || options.reported()[bound.key] !== bound.value) {
          throw new AgentSessionOptionRejectedError('The agent did not confirm the service tier')
        }
        return () => {}
      } finally {
        options.commandReply = null
      }
    })
  }
  return boundAcpOptionWrite(options, { ...bound, onUncertain: undefined }, () =>
    write.method === 'config'
      ? connection
          .setConfigOption(write.configId, write.value, undefined, undefined, timeoutMs)
          .then((result) => () => options.adoptConfigOptions(result.configOptions))
      : connection
          .setModel(write.modelId, undefined, timeoutMs)
          .then(() => () => options.adoptModel(write.modelId))
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
  let failed = false
  let native: Promise<() => string | void> | null = null
  let completed = false
  // A withdrawn control may still land, so this one is sent only after it settles.
  const applied = options
    .whenControlsSettle()
    .then(() => {
      if (failed) {
        throw new Error(`${agent} option write was withdrawn before it was sent`)
      }
      native = send()
      // Orca's own write stays in flight until the agent answers, so its echo is not drift.
      const released = (): void => {
        options.writing -= 1
      }
      native.then(released, released)
      return native
    })
    .then((apply) => {
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
    let settled = false
    const fail = (error: Error): void => {
      if (settled) {
        return
      }
      if (options.writeRevision === revision) {
        options.writeRevision += 1
      }
      failed = true
      settle()
      if (native === null) {
        options.writing -= 1
      } else if (!completed) {
        // A local deadline/abort cannot cancel an already-sent native control.
        options.holdUntilSettled(native, bound.key)
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
    const settle = (): void => {
      if (settled) {
        return
      }
      settled = true
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

/** A prompt waits for withdrawn controls, each bounded by its call deadline, or for its own abort. */
export async function acpControlsSettled(
  session: { options: AcpStructuredOptions },
  signal?: AbortSignal
): Promise<void> {
  if (!signal) {
    return session.options.whenControlsSettle()
  }
  signal.throwIfAborted()
  let onAbort = (): void => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortSignalReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([session.options.whenControlsSettle(), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
