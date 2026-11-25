import { Readable } from 'node:stream'
import type { ProviderOwnerProcess } from './provider-child'
import { constants } from 'node:os'

export type ProviderLeaderOutcome = { code: number | null; signal: NodeJS.Signals | null }

/** Only the native parent holds this pipe; EOF follows its actual CLI wait status. */
export function readProviderLeaderOutcome(stream: Readable): Promise<ProviderLeaderOutcome | null> {
  return new Promise((resolve) => {
    let buffer = ''
    let ended = false
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      if (buffer.length > 256) {
        stream.destroy()
      }
    })
    stream.once('end', () => {
      ended = true
      try {
        if (!buffer.endsWith('\n')) {
          resolve(null)
          return
        }
        const value: unknown = JSON.parse(buffer)
        if (!value || typeof value !== 'object' || !('code' in value) || !('signal' in value)) {
          resolve(null)
          return
        }
        if (
          value.signal === null &&
          Number.isInteger(value.code) &&
          Number(value.code) >= 0 &&
          Number(value.code) <= 255
        ) {
          resolve({ code: Number(value.code), signal: null })
          return
        }
        const signal = Object.entries(constants.signals).find(([, n]) => n === value.signal)?.[0]
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: signal is a key read directly from the platform's Node signal-name table.
        const namedSignal = signal as NodeJS.Signals | undefined
        resolve(value.code === null && namedSignal ? { code: null, signal: namedSignal } : null)
      } catch {
        resolve(null)
      }
    })
    stream.once('error', () => resolve(null))
    stream.once('close', () => {
      if (!ended) {
        resolve(null)
      }
    })
  })
}

export function observeProviderLeaderOutcome(
  raw: ProviderOwnerProcess
): Promise<ProviderLeaderOutcome | null> {
  const pipe = raw.stdio?.at(6)
  const result = pipe instanceof Readable ? readProviderLeaderOutcome(pipe) : Promise.resolve(null)
  // EOF/error is itself lost-outcome evidence, even while H reaps detached descendants.
  if (raw.pid !== undefined) {
    return result
  }
  return new Promise((resolve) => {
    // A hosted launch reports its PID later; until then it may still prove processless.
    raw.once('spawn', () => resolve(result))
    // A processless spawn has no CLI frame; preserve its actual spawn-failure close status.
    raw.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      resolve({ code, signal })
    })
  })
}
