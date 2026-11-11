import { spawnClaudeConversationWorker } from './claude-rewind-transcript'

/** The active-chain scan stays off the main process; acknowledge each chunk after staging it. */
export async function recoverClaudeTranscript(input: {
  filePath: string
  signal: AbortSignal
  restore: (row: Record<string, unknown>) => void
  yieldTurn: () => Promise<void>
}): Promise<void> {
  input.signal.throwIfAborted()
  const worker = spawnClaudeConversationWorker({ kind: 'recover', filePath: input.filePath })
  let abort = () => {}
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(input.signal.reason)
      input.signal.addEventListener('abort', abort, { once: true })
      worker.on(
        'message',
        (message: { rows?: Record<string, unknown>[]; error?: string; result?: null }) => {
          if (message.error) {
            reject(new Error(message.error))
            return
          }
          if (!message.rows) {
            resolve()
            return
          }
          const rows = message.rows
          void (async () => {
            for (const row of rows) {
              input.signal.throwIfAborted()
              input.restore(row)
              await input.yieldTurn()
            }
            worker.postMessage('next')
          })().catch(reject)
        }
      )
      worker.once('error', reject)
      worker.once('exit', (code) => {
        if (code !== 0) {
          reject(new Error('Claude history scan failed'))
        }
      })
      if (input.signal.aborted) {
        abort()
      }
    })
  } finally {
    input.signal.removeEventListener('abort', abort)
    await worker.terminate()
  }
}
