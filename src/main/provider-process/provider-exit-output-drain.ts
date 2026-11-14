import type { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'

/** How long an exited child's output may still deliver answers before its pending calls fail. */
export const PROVIDER_EXIT_OUTPUT_DRAIN_MS = 1_000

/** Process exit can be observed before stdout is read to its end, so an answer written just
 *  before exit would otherwise lose to the exit. Runs `finish` once stdout ends or closes, the
 *  child reports all its stdio closed, or the bound passes while a descendant still holds the
 *  pipe. Returns a way to finish now. */
export function afterProviderOutputDrains(
  stdout: Readable,
  finish: () => void,
  child?: EventEmitter
): () => void {
  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const done = (): void => {
    if (finished) {
      return
    }
    finished = true
    clearTimeout(timer)
    stdout.removeListener('end', done)
    stdout.removeListener('close', done)
    child?.removeListener('close', done)
    finish()
  }
  if (stdout.destroyed || stdout.readableEnded) {
    done()
    return done
  }
  stdout.once('end', done)
  stdout.once('close', done)
  child?.once('close', done)
  timer = setTimeout(done, PROVIDER_EXIT_OUTPUT_DRAIN_MS)
  timer.unref?.()
  return done
}
