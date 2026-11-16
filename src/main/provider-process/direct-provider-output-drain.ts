import { ignoreProviderTransportError } from './provider-child'
import { PassThrough, type Readable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS } from './provider-process-supervisor'

export function pipeDirectProviderOutput(
  raw: ChildProcess,
  stdout: PassThrough,
  stderr: PassThrough
): () => void {
  const stdoutError = (error: Error): void => {
    stdout.destroy(error)
  }
  const stderrError = (error: Error): void => {
    stderr.destroy(error)
  }
  raw.stdout?.on('error', stdoutError)
  raw.stderr?.on('error', stderrError)
  stdout.on('error', ignoreProviderTransportError)
  stderr.on('error', ignoreProviderTransportError)
  // Protocol peers see EOF after group cleanup and drain, including readers attached after exit.
  raw.stdout?.pipe(stdout, { end: false })
  raw.stderr?.pipe(stderr, { end: false })
  return () => {
    raw.stdout?.unpipe(stdout)
    raw.stderr?.unpipe(stderr)
    raw.stdout?.off('error', stdoutError)
    raw.stderr?.off('error', stderrError)
  }
}

export function drainDirectProviderOutput(
  stdout: Readable | null | undefined,
  stderr: Readable | null | undefined,
  outputStdout: PassThrough,
  outputStderr: PassThrough
): Promise<void> {
  const endingReaders: (() => void)[] = []
  for (const [source, output] of [
    [stdout, outputStdout],
    [stderr, outputStderr]
  ] as const) {
    if (!source || source.readableEnded || source.destroyed) {
      output.end()
    } else {
      const end = (): void => {
        output.end()
      }
      source.once('end', end)
      source.once('close', end)
      endingReaders.push(() => {
        source.off('end', end)
        source.off('close', end)
      })
    }
  }
  const sources = [stdout, stderr].filter(
    (stream): stream is Readable => stream !== null && stream !== undefined
  )
  return drainOutput(sources, [outputStdout, outputStderr]).finally(async () => {
    const finalReaders: (() => void)[] = []
    for (const [source, output] of [
      [stdout, outputStdout],
      [stderr, outputStderr]
    ] as const) {
      source?.unpipe(output)
      if (source && !source.destroyed) {
        const forward = (chunk: Buffer): void => {
          output.write(chunk)
        }
        source.on('data', forward)
        source.resume()
        finalReaders.push(() => {
          source.off('data', forward)
          source.destroy()
        })
      }
    }
    // An overdue deadline still gives kernel-buffered tail bytes one poll phase to arrive.
    await new Promise<void>((resolve) => setImmediate(resolve))
    for (const cleanup of finalReaders) {
      cleanup()
    }
    for (const cleanup of endingReaders) {
      cleanup()
    }
    outputStdout.end()
    outputStderr.end()
  })
}

async function drainOutput(sources: Readable[], outputs: PassThrough[]): Promise<void> {
  const cleanups: (() => void)[] = []
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      Promise.all(
        [...sources, ...outputs].map(
          (stream) =>
            new Promise<void>((resolve) => {
              const output = stream instanceof PassThrough
              if (stream.destroyed || (output ? stream.writableFinished : stream.readableEnded)) {
                resolve()
                return
              }
              const done = (): void => {
                resolve()
              }
              const event = output ? 'finish' : 'end'
              stream.once(event, done)
              stream.once('close', done)
              cleanups.push(() => {
                stream.off(event, done)
                stream.off('close', done)
              })
            })
        )
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS)
      })
    ])
  } finally {
    clearTimeout(timer)
    for (const cleanup of cleanups) {
      cleanup()
    }
  }
}
