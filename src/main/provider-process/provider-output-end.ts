import type { Readable, Writable } from 'node:stream'
import { afterProviderOutputDrains } from './provider-exit-output-drain'
import { detachProviderStreamErrorHandler } from './provider-stdio-error-boundary'

/** The agent stopped reading what Orca writes. Nothing more is written, but calls it may already
 *  have answered settle only once its output ends or the drain bound passes. */
export class ProviderOutputEnd {
  error?: Error
  private detached = false

  constructor(
    private readonly output: Writable,
    private readonly ended: (error: Error) => void,
    private readonly closedError: () => Error
  ) {
    output.on('close', this.onClosed)
    output.on('finish', this.onClosed)
    output.on('error', this.onError)
  }

  /** False when the output already ended; the first end is the one its calls settle with. */
  begin(error: Error): boolean {
    if (this.error) {
      return false
    }
    this.error = error
    this.detach()
    return true
  }

  /** `close` runs now when no call waits, else once `wait` (by default the output drain) ends. */
  settle(
    waiting: boolean,
    input: Readable,
    close: () => void,
    wait?: (finish: () => void) => void
  ): void {
    if (!waiting) {
      close()
    } else if (wait) {
      wait(close)
    } else {
      afterProviderOutputDrains(input, close)
    }
  }

  detach(): void {
    if (this.detached) {
      return
    }
    this.detached = true
    this.output.removeListener('close', this.onClosed)
    this.output.removeListener('finish', this.onClosed)
    detachProviderStreamErrorHandler(this.output, this.onError)
  }

  private readonly onClosed = (): void => this.ended(this.closedError())
  private readonly onError = (error: Error): void => this.ended(error)
}
