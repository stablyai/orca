import { once } from 'node:events'
import { mainChain } from './claude-transcript-tail'
import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { createReadStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { parentPort, workerData } from 'node:worker_threads'

import { publishClaudeConversationTranscript } from './claude-conversation-transcript-publication'
import { AgentConversationCopyError } from '../../native-chat/agent-conversation-copy-error'
import {
  claudeConversationForkBoundary,
  isClaudeConversationEntry,
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
  let coverage: string[] = []
  const result = await forkSession(input.sourceSessionId, {
    upToMessageId: throughEntryId,
    ...(input.title ? { title: input.title } : {}),
    sessionStore: {
      load: async () => entries,
      append: async (key, entries) => {
        coverage = entries
          .filter((entry) => isClaudeConversationEntry(entry))
          .map((entry) => entry.uuid)

        resumeCursor = entries.findLast(
          (entry) => entry.type === 'assistant' || entry.type === 'user'
        )?.uuid
        if (!resumeCursor) {
          return
        }
        await mkdir(input.destinationDirectory, { recursive: true })
        await publishClaudeConversationTranscript(
          input.temporaryPath,
          join(input.destinationDirectory, `${key.sessionId}.jsonl`),
          entries
        )
      }
    }
  })
  return resumeCursor
    ? {
        sessionId: result.sessionId,
        resumeCursor,
        coverage: { unit: 'claude-entry' as const, ids: coverage },
        filePath: join(input.destinationDirectory, `${result.sessionId}.jsonl`)
      }
    : null
}

async function recover(filePath: string) {
  const rows: Record<string, unknown>[] = []
  const stream = createReadStream(filePath)
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      try {
        const value = JSON.parse(line)
        if (
          value &&
          typeof value.uuid === 'string' &&
          value.isSidechain !== true &&
          value.parent_tool_use_id == null
        ) {
          rows.push(value)
        }
      } catch {
        /* A torn line is left for the next read. */
      }
    }
  } finally {
    stream.destroy()
  }
  const chain = mainChain(rows, '').rows
  for (let index = 0; index < chain.length; index += 128) {
    const ack = once(parentPort!, 'message')
    parentPort?.postMessage({ rows: chain.slice(index, index + 128) })
    await ack
  }
  return null
}

;(workerData.kind === 'recover' ? recover(workerData.filePath) : fork(workerData)).then(
  (result) => parentPort?.postMessage({ result }),
  (error) =>
    parentPort?.postMessage({
      error: error instanceof Error ? error.message : String(error),
      copyError: error instanceof AgentConversationCopyError
    })
)
