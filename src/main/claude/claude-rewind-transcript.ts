import { AgentConversationCopyError } from '../native-chat/agent-conversation-copy-error'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { AgentSessionRewindFork } from '../../shared/agent-session/lifecycle/agent-session-rewind'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../worker-threads/worker-thread-entry-path'
import type { ClaudeConversationForkWork } from './claude-conversation-fork-worker-entry'

type ConversationCopy = { sessionId: string; resumeCursor: string; filePath: string }

/** The native materializer is CPU/memory heavy even when reached through rewind. */
export async function materializeClaudeConversationTranscript(input: {
  sourcePath: string
  sourceSessionId: string
  throughEntryId: string
  destinationDirectory?: string
  title?: string
  signal?: AbortSignal
}): Promise<ConversationCopy | null> {
  input.signal?.throwIfAborted()
  const destinationDirectory = input.destinationDirectory ?? dirname(input.sourcePath)
  const temporaryPath = join(destinationDirectory, `.fork-${randomUUID()}.tmp`)
  const compiled = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(import.meta.dirname),
    'claude-conversation-fork-worker-entry.js'
  )
  const entry = existsSync(compiled)
    ? compiled
    : new URL('./claude-conversation-fork-worker-entry.ts', import.meta.url)
  const signal = AbortSignal.any([
    AbortSignal.timeout(60_000),
    ...(input.signal ? [input.signal] : [])
  ])
  const workerData: ClaudeConversationForkWork = {
    sourcePath: input.sourcePath,
    sourceSessionId: input.sourceSessionId,
    throughEntryId: input.throughEntryId,
    title: input.title,
    destinationDirectory,
    temporaryPath
  }
  const worker = new Worker(entry, { workerData, resourceLimits: { maxOldGenerationSizeMb: 512 } })
  let abort: () => void = () => undefined
  try {
    return await new Promise<ConversationCopy | null>((resolve, reject) => {
      abort = () =>
        reject(
          new AgentConversationCopyError('Claude could not finish copying this chat. Try again.')
        )
      signal.addEventListener('abort', abort, { once: true })
      worker.once('message', (message: { result?: ConversationCopy | null; error?: string }) => {
        if (message.error) {
          reject(new AgentConversationCopyError('Claude could not copy this chat. Try again.'))
        } else {
          resolve(message.result ?? null)
        }
      })
      worker.once('error', (error) =>
        reject(
          new AgentConversationCopyError(
            error.message.includes('memory')
              ? 'Claude could not copy this chat because it is too large. Fork an earlier response.'
              : 'Claude could not copy this chat. Try again.',
            { cause: error }
          )
        )
      )
      worker.once('exit', (code) => {
        if (code !== 0) {
          reject(new AgentConversationCopyError('Claude could not copy this chat. Try again.'))
        }
      })
      if (signal.aborted) {
        abort()
      }
    })
  } finally {
    signal.removeEventListener('abort', abort)
    await worker.terminate()
    await rm(temporaryPath, { force: true })
  }
}

export async function materializeClaudeRewindTranscript(
  sourcePath: string,
  fork: AgentSessionRewindFork,
  destinationDirectory?: string
): Promise<AgentSessionRewindFork> {
  if (!fork.throughEntryId) {
    return { ...fork, materialized: true }
  }
  const copy = await materializeClaudeConversationTranscript({
    sourcePath,
    sourceSessionId: fork.sourceSessionId,
    throughEntryId: fork.throughEntryId,
    destinationDirectory
  })
  return copy
    ? { ...fork, sessionId: copy.sessionId, resumeCursor: copy.resumeCursor, materialized: true }
    : {
        sessionId: fork.sessionId,
        sourceSessionId: fork.sourceSessionId,
        replacesSessionId: fork.replacesSessionId,
        materialized: true
      }
}
