const STOP_KEY = 0x1d

export async function recordPtyTranscript({ spawn, sink, stdin, stdout, options }) {
  let recording = true
  let term
  let stopping = false
  const timers = []
  const wasRaw = stdin.isTTY === true && stdin.isRaw === true
  const stop = () => {
    if (stopping) {
      return
    }
    stopping = true
    recording = false
    try {
      term.kill()
    } catch {
      // A concurrent physical exit can make the native handle unavailable.
    }
  }
  const onInput = (chunk) => {
    if (chunk.includes(STOP_KEY)) {
      stop()
    } else if (!stopping) {
      term.write(chunk)
    }
  }
  let sinkFailure
  const onSinkError = (error) => {
    sinkFailure = error
    if (term) {
      stop()
    }
  }
  sink.on('error', onSinkError)
  let exitCode
  let captureFailure
  try {
    term = await spawn((bytes) => {
      if (recording) {
        sink.write(bytes)
      }
      stdout.write(bytes)
    })
    const exit = new Promise((resolve) => term.onExit(({ exitCode }) => resolve(exitCode ?? 0)))
    await term.waitForSpawn?.()
    if (sinkFailure) {
      throw sinkFailure
    }
    if (stdin.isTTY) {
      stdin.setRawMode(true)
    }
    stdin.on('data', onInput)
    stdin.resume()
    for (const send of options.sends) {
      timers.push(
        setTimeout(() => {
          if (!stopping) {
            term.write(send.text)
          }
        }, send.atMs)
      )
    }
    if (options.duration !== null) {
      timers.push(setTimeout(stop, options.duration * 1000))
    }
    exitCode = await exit
  } catch (error) {
    captureFailure = error
  } finally {
    recording = false
    for (const timer of timers) {
      clearTimeout(timer)
    }
    stdin.off('data', onInput)
    if (stdin.isTTY) {
      stdin.setRawMode(wasRaw)
    }
    stdin.pause()
    try {
      term?.destroy()
    } catch (error) {
      captureFailure ??= error
    }
    await new Promise((resolve) => {
      if (sink.destroyed) {
        return resolve()
      }
      sink.once('error', resolve)
      sink.end(resolve)
    })
    sink.off('error', onSinkError)
  }
  if (captureFailure || sinkFailure) {
    throw captureFailure ?? sinkFailure
  }
  return exitCode
}
