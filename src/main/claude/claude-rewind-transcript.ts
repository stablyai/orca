import { AgentConversationCopyError } from '../native-chat/agent-conversation-copy-error'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AgentSessionRewindFork } from '../../shared/agent-session/lifecycle/agent-session-rewind'
import { spawnWorkerThread } from '../worker-threads/worker-thread-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../worker-threads/worker-thread-entry-path'
import { durableWriteTempPath } from '../filesystem/durable-file-write'
import type { ClaudeForkCheckpoint } from './claude-conversation-fork-boundary'
import type { ClaudeConversationForkWork } from './claude-conversation-fork-worker-entry'

type ConversationCopy = {
  sessionId: string
  resumeCursor: string
  filePath: string
  coverage: { unit: 'claude-entry'; ids: string[] }
}

/** The native materializer is CPU/memory heavy even when reached through rewind. */
export async function materializeClaudeConversationTranscript(input: {
  sourcePath: string
  sourceSessionId: string
  throughEntryId?: string
  checkpoint?: ClaudeForkCheckpoint
  rewind?: true
  destinationDirectory?: string
  title?: string
  signal?: AbortSignal
}): Promise<ConversationCopy | null> {
  input.signal?.throwIfAborted()
  const destinationDirectory = input.destinationDirectory ?? dirname(input.sourcePath)
  const temporaryPath = durableWriteTempPath(join(destinationDirectory, 'conversation.jsonl'))
  const signal = input.signal
  const failure = input.rewind
    ? 'Claude could not rewind this chat. Try again.'
    : 'Claude could not copy this chat. Try again.'
  const workerData: ClaudeConversationForkWork = {
    sourcePath: input.sourcePath,
    sourceSessionId: input.sourceSessionId,
    throughEntryId: input.throughEntryId,
    checkpoint: input.checkpoint,
    title: input.title,
    destinationDirectory,
    temporaryPath
  }
  const worker = spawnClaudeConversationWorker(workerData)
  let abort: () => void = () => undefined
  try {
    return await new Promise<ConversationCopy | null>((resolve, reject) => {
      abort = () =>
        reject(
          new AgentConversationCopyError(
            input.rewind ? failure : 'Claude took too long to copy this chat. Try again.'
          )
        )
      signal?.addEventListener('abort', abort, { once: true })
      worker.once(
        'message',
        (message: { result?: ConversationCopy | null; error?: string; copyError?: boolean }) => {
          if (message.error) {
            reject(
              new AgentConversationCopyError(
                message.copyError && !input.rewind ? message.error : failure
              )
            )
          } else {
            resolve(message.result ?? null)
          }
        }
      )
      worker.once('error', (error) =>
        reject(
          new AgentConversationCopyError(
            ('code' in error && error.code === 'ERR_WORKER_OUT_OF_MEMORY') ||
              error.message.includes('memory')
              ? `Claude ran out of memory while ${input.rewind ? 'rewinding' : 'copying'} this chat. Close other apps, then try again.`
              : failure,
            { cause: error }
          )
        )
      )
      worker.once('exit', (code) => {
        if (code !== 0) {
          reject(new AgentConversationCopyError(failure))
        }
      })
      if (signal?.aborted) {
        abort()
      }
    })
  } finally {
    signal?.removeEventListener('abort', abort)
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
    return { ...fork, materialized: true, coverage: [] }
  }
  const copy = await materializeClaudeConversationTranscript({
    sourcePath,
    rewind: true,
    sourceSessionId: fork.sourceSessionId,
    throughEntryId: fork.throughEntryId,
    destinationDirectory
  })
  return copy
    ? {
        ...fork,
        sessionId: copy.sessionId,
        resumeCursor: copy.resumeCursor,
        coverage: copy.coverage.ids,
        materialized: true
      }
    : {
        sessionId: fork.sessionId,
        sourceSessionId: fork.sourceSessionId,
        replacesSessionId: fork.replacesSessionId,
        materialized: true,
        coverage: []
      }
}

export function spawnClaudeConversationWorker(workerData: unknown) {
  const compiled = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(__dirname),
    'claude-conversation-fork-worker-entry.js'
  )
  const installed = [
    compiled,
    join(dirname(compiled), '..', 'claude-conversation-fork-worker-entry.js')
  ].find(existsSync)
  const entry = installed
    ? installed
    : new URL('./claude-conversation-fork-worker-entry.ts', import.meta.url)
  return spawnWorkerThread(entry, { workerData })
}
