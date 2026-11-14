import { PassThrough, type Readable } from 'node:stream'
import { PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS } from './provider-process-supervisor'

export function drainDirectProviderOutput(
  stdout: Readable | null,
  stderr: Readable | null,
  outputStdout: PassThrough,
  outputStderr: PassThrough
): Promise<void> {
  for (const [source, output] of [
    [stdout, outputStdout],
    [stderr, outputStderr]
  ] as const) {
    if (!source || source.readableEnded || source.destroyed) {
      output.end()
    } else {
      source.once('end', () => output.end())
      source.once('close', () => output.end())
    }
  }
  const sources = [stdout, stderr].filter((stream): stream is Readable => stream !== null)
  return drainOutput(sources, [outputStdout, outputStderr]).finally(() => {
    for (const [source, output] of [
      [stdout, outputStdout],
      [stderr, outputStderr]
    ] as const) {
      if (source && !source.destroyed) {
        source.unpipe(output)
        source.pause()
        const remaining = source.readableLength
        if (remaining > 0) {
          output.write(source.read(remaining))
        }
        source.destroy()
      }
      output.end()
    }
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
