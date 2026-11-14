import { finished, type PassThrough, type Readable } from 'node:stream'

/** The sole writer has exited; retain its finite socket tail without driving the public reader. */
export function retainProviderOutput(source: Readable, output: PassThrough): Promise<void> {
  source.unpipe(output)
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const outputClosed = (): void => {
      if (!output.readableEnded) {
        fail(new Error('Agent output was closed before delivery'))
      }
    }
    const data = (chunk: Buffer): void => {
      try {
        if (output.destroyed || output.errored || output.writableEnded) {
          throw new Error('Agent output ended before delivery')
        }
        output.write(chunk)
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Agent output could not be delivered'))
      }
    }
    let stopObserving = (): void => {}
    const cleanup = (): void => {
      stopObserving()
      source.off('data', data)
      output.off('error', fail)
      output.off('close', outputClosed)
    }
    source.on('data', data)
    output.on('error', fail)
    output.on('close', outputClosed)
    stopObserving = finished(source, { writable: false }, (error) => {
      if (error) {
        fail(error)
        return
      }
      try {
        if (output.errored || (output.destroyed && !output.readableEnded)) {
          throw new Error('Agent output ended before delivery')
        }
        output.end()
        cleanup()
        resolve()
      } catch (failure) {
        fail(failure instanceof Error ? failure : new Error('Agent output could not be delivered'))
      }
    })
    if (output.errored || (output.destroyed && !output.readableEnded)) {
      fail(output.errored ?? new Error('Agent output was closed before delivery'))
    } else {
      source.resume()
    }
  })
}
