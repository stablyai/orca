import type { Readable } from 'node:stream'

const LISTENING_LINE = /Debug server listening at (\S+):(\d+)/

/**
 * `dapDebugServer.js` (vendored vscode-js-debug) speaks DAP over a TCP
 * socket it opens itself, not over its own stdio — so before we can connect,
 * we scan its stdout for the port it actually bound (`0` in, OS-assigned
 * port out; requesting a fixed port would race other sessions/processes).
 */
export function waitForJsDebugListeningPort(stdout: Readable, timeoutMs = 15_000): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for the js-debug adapter to report its listening port`))
    }, timeoutMs)

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      const match = LISTENING_LINE.exec(buffer)
      if (match) {
        cleanup()
        resolve(Number(match[2]))
      }
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error('js-debug adapter process closed before reporting a listening port'))
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      stdout.off('data', onData)
      stdout.off('close', onClose)
    }

    stdout.on('data', onData)
    stdout.on('close', onClose)
  })
}
