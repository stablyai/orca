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
    const finish = (err?: Error): void => {
      db.close()
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    }
    options.input.on('data', (chunk: Buffer) => {
      let frames: string[]
      try {
        frames = decoder.feed(chunk)
      } catch (err) {
        // Corrupt framing is unrecoverable for this connection.
        if (err instanceof NativeMessageFrameError) {
          options.output.write(encodeNativeMessage({ type: 'ERROR', error: err.message }))
        }
        finish(err instanceof Error ? err : new Error(String(err)))
        return
      }
      for (const raw of frames) {
        options.output.write(encodeNativeMessage(processChatImportHostMessage(db, raw, now())))
      }
    })
    options.input.on('end', () => finish())
    options.input.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))))
  })
}
