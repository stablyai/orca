import { openChatImportDbForWrite } from '../../main/chat-import/chat-import-db-open'
import { processChatImportHostMessage } from './chat-import-host-protocol'
import {
  encodeNativeMessage,
  NativeMessageDecoder,
  NativeMessageFrameError
} from './native-messaging-frame'

// Why: a short-lived native host owns stdin/stdout for one browser session.
// Streams are injected so tests drive it without real pipes.
export function runChatImportHost(options: {
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
  dbPath: string
  now?: () => string
}): Promise<void> {
  const db = openChatImportDbForWrite(options.dbPath)
  const decoder = new NativeMessageDecoder()
  const now = options.now ?? (() => new Date().toISOString())

  return new Promise<void>((resolve, reject) => {
    // Why: 'data' (framing-error branch), 'end', and 'error' can each fire finish()
    // for the same connection (e.g. an oversized frame throws, then the stream's
    // natural 'end' follows) — without a guard, a second db.close() throws
    // ERR_INVALID_STATE and crashes the host.
    let finished = false
    const finish = (err?: Error): void => {
      if (finished) {
        return
      }
      finished = true
      options.input.removeAllListeners('data')
      options.input.removeAllListeners('end')
      options.input.removeAllListeners('error')
      db.close()
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    }
    const respond = (raw: string): void => {
      options.output.write(encodeNativeMessage(processChatImportHostMessage(db, raw, now())))
    }
    options.input.on('data', (chunk: Buffer) => {
      let frames: string[]
      try {
        frames = decoder.feed(chunk)
      } catch (err) {
        if (err instanceof NativeMessageFrameError) {
          // Corrupt framing is unrecoverable for this connection, but the ERROR
          // frame already told the caller what happened — end cleanly rather
          // than reject, since nothing else went wrong at the process level.
          // Frames decoded before the bad one are intact, so answer them first.
          err.decodedFrames.forEach(respond)
          options.output.write(encodeNativeMessage({ type: 'ERROR', error: err.message }))
          finish()
        } else {
          finish(err instanceof Error ? err : new Error(String(err)))
        }
        return
      }
      frames.forEach(respond)
    })
    options.input.on('end', () => finish())
    options.input.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))))
  })
}
