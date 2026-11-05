import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { parentPort, workerData } from 'node:worker_threads'

export type ClaudeConversationForkWork = {
  sourcePath: string
  sourceSessionId: string
  throughEntryId: string
  destinationDirectory: string
  temporaryPath: string
  title?: string
}

async function fork(input: ClaudeConversationForkWork) {
  const { forkSession } = await import('@anthropic-ai/claude-agent-sdk')
  let resumeCursor: string | undefined
  const result = await forkSession(input.sourceSessionId, {
    upToMessageId: input.throughEntryId,
    ...(input.title ? { title: input.title } : {}),
    sessionStore: {
      load: async () => {
        const entries: SessionStoreEntry[] = []
        const stream = createReadStream(input.sourcePath)
        try {
          for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
            try {
              const value = JSON.parse(line)
              if (value && typeof value.type === 'string') {
                entries.push(value)
              }
            } catch {
              // Ignore a crash-torn line, as the native reader does.
            }
          }
        } finally {
          stream.destroy()
        }
        return entries
      },
      append: async (key, entries) => {
        resumeCursor = entries.findLast(
          (entry) => entry.type === 'assistant' || entry.type === 'user'
        )?.uuid
        if (!resumeCursor) {
          return
        }
        await mkdir(input.destinationDirectory, { recursive: true })
        const output = await open(input.temporaryPath, 'wx', 0o600)
        try {
          for (const entry of entries) {
            await output.write(`${JSON.stringify(entry)}\n`)
          }
          await output.sync()
        } finally {
          await output.close()
        }
        const destination = join(input.destinationDirectory, `${key.sessionId}.jsonl`)
        await rename(input.temporaryPath, destination)
        if (process.platform !== 'win32') {
          const directory = await open(dirname(destination), 'r')
          try {
            await directory.sync()
          } finally {
            await directory.close()
          }
        }
      }
    }
  })
  return resumeCursor
    ? {
        sessionId: result.sessionId,
        resumeCursor,
        filePath: join(input.destinationDirectory, `${result.sessionId}.jsonl`)
      }
    : null
}

fork(workerData).then(
  (result) => parentPort?.postMessage({ result }),
  (error) =>
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) })
)
