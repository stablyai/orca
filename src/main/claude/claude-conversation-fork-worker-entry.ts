import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { createReadStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { parentPort, workerData } from 'node:worker_threads'

import { renameDurable, writeTempFileDurable } from '../filesystem/durable-file-write'
import { AgentConversationCopyError } from '../native-chat/agent-conversation-copy-error'
import {
  claudeConversationForkBoundary,
  type ClaudeForkCheckpoint
} from './claude-conversation-fork-boundary'

export type ClaudeConversationForkWork = {
  sourcePath: string
  sourceSessionId: string
  throughEntryId?: string
  checkpoint?: ClaudeForkCheckpoint
  destinationDirectory: string
  temporaryPath: string
  title?: string
}

async function fork(input: ClaudeConversationForkWork) {
  const { forkSession } = await import('@anthropic-ai/claude-agent-sdk')
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
  const throughEntryId = input.checkpoint
    ? claudeConversationForkBoundary(entries, input.checkpoint)
    : input.throughEntryId
  let resumeCursor: string | undefined
  const result = await forkSession(input.sourceSessionId, {
    upToMessageId: throughEntryId,
    ...(input.title ? { title: input.title } : {}),
    sessionStore: {
      load: async () => entries,
      append: async (key, entries) => {
        resumeCursor = entries.findLast(
          (entry) => entry.type === 'assistant' || entry.type === 'user'
        )?.uuid
        if (!resumeCursor) {
          return
        }
        await mkdir(input.destinationDirectory, { recursive: true })
        await writeTempFileDurable(
          input.temporaryPath,
          entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
          0o600
        )
        const destination = join(input.destinationDirectory, `${key.sessionId}.jsonl`)
        await renameDurable(input.temporaryPath, destination)
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
    parentPort?.postMessage({
      error: error instanceof Error ? error.message : String(error),
      copyError: error instanceof AgentConversationCopyError
    })
)
