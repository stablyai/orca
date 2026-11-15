import { Readable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
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
        resolve(
          value.code === null && signal ? { code: null, signal: signal as NodeJS.Signals } : null
        )
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
  raw: ChildProcess
): Promise<ProviderLeaderOutcome | null> {
  const pipe = raw.stdio?.at(6)
  const result = pipe instanceof Readable ? readProviderLeaderOutcome(pipe) : Promise.resolve(null)
  return new Promise((resolve) => {
    void result.then((outcome) => {
      if (outcome) {
        resolve(outcome)
      }
    })
    // A parent exit without its wait frame leaves the CLI outcome unknown.
    raw.once('exit', () => {
      void result.then(resolve)
    })
    raw.once('close', (code, signal) => {
      if (raw.pid === undefined) {
        resolve({ code, signal })
      }
    })
  })
}
