import { existsSync } from 'node:fs'
import type { AgentType } from '../../../shared/agent-status/contracts/agent-status-types'
import { resolveNativeChatTranscriptAgent } from '../../../shared/native-chat/native-chat-agent-support'
import {
  selectNativeChatFindMatch,
  type NativeChatFindArgs,
  type NativeChatFindDocument,
  type NativeChatFindOutcome
} from '../../../shared/native-chat/find/native-chat-session-find'
import { unrefTimer } from '../../../shared/timers/unref-timer'
import { LazyWorkerThreadHost } from '../../worker-threads/lazy-worker-thread-host'
import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-threads/worker-thread-entry-path'
import type { WorkerThreadFactory } from '../../worker-threads/worker-thread-transport'
import { resolveSessionFilePath } from '../session-file-resolver'
import { nativeChatLineDecoderForAgent } from '../transcript-decoding/native-chat-line-decoder'
import {
  openTranscriptReadStream,
  transcriptFileStat
} from '../transcript-filesystem/wsl-transcript-fs-access'
import { wslTranscriptFsRefusal } from '../transcript-filesystem/wsl-transcript-fs-error'
import type {
  NativeChatTranscriptFindCommand,
  NativeChatTranscriptFindResponse
} from './native-chat-transcript-find-protocol'

/** Find stays warm while someone types or steps; idle for this long, it lets go of everything. */
const FIND_IDLE_MS = 60_000
const COMPLETED_SCANS_MAX = 8
/** Bytes per hand-off to the worker; each waits for the last, so a read never outruns it. */
const SEND_CHUNK_BYTES = 1024 * 1024

function nativeChatFindWorkerFactory() {
  const path = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(__dirname),
    'native-chat-transcript-find-worker-entry.js'
  )
  if (!existsSync(path)) {
    throw new Error(`Chat find worker entry not found: ${path}`)
  }
  return spawnWorkerThread(path, {
    name: 'orca-native-chat-find',
    resourceLimits: { maxOldGenerationSizeMb: 256 }
  })
}

type Call = {
  onResponse: (response: NativeChatTranscriptFindResponse) => void
  onGone: (error: Error) => void
}

export class NativeChatTranscriptFind {
  private nextId = 0
  private readonly calls = new Map<number, Call>()
  private readonly host: LazyWorkerThreadHost<NativeChatTranscriptFindResponse>
  /** Recent completed scans by transcript version and query, so a step past the result's
   *  navigation selects again without reading. */
  private readonly completed = new Map<string, NativeChatFindDocument[]>()
  private completedTimer: ReturnType<typeof setTimeout> | null = null

  constructor(factory: WorkerThreadFactory = nativeChatFindWorkerFactory) {
    this.host = new LazyWorkerThreadHost({
      factory,
      idleTeardownMs: FIND_IDLE_MS,
      isIdle: () => this.calls.size === 0,
      onMessage: (response) => this.calls.get(response.id)?.onResponse(response),
      onError: (error) => this.fail(error),
      onExit: () => this.fail(new Error('Chat find worker exited')),
      onUnavailable: () => undefined
    })
  }

  /** `args.transcriptPath` is already mapped onto this host, as reads map it. */
  async find(args: NativeChatFindArgs, signal?: AbortSignal): Promise<NativeChatFindOutcome> {
    const { agent, sessionId, input } = args
    if (
      resolveNativeChatTranscriptAgent(agent) === 'opencode' ||
      !nativeChatLineDecoderForAgent(agent)
    ) {
      return { unsupported: true }
    }
    let filePath: string | null
    try {
      filePath = await resolveSessionFilePath(
        agent,
        sessionId,
        { transcriptPath: args.transcriptPath },
        signal
      )
    } catch (error) {
      signal?.throwIfAborted()
      return { error: wslTranscriptFsRefusal(error).message }
    }
    if (!filePath) {
      return { error: 'Transcript unavailable' }
    }
    const stat = await transcriptFileStat(filePath, 'exact', signal)
    const version = `${filePath}\0${stat.size}\0${stat.mtimeMs}`
    const key = `${version}\0${input.query}`
    this.touchCompleted()
    let documents = this.completed.get(key)
    if (documents) {
      this.completed.delete(key)
    } else {
      documents = await this.scan(agent, filePath, version, stat.size, input.query, signal)
    }
    this.completed.set(key, documents)
    if (this.completed.size > COMPLETED_SCANS_MAX) {
      this.completed.delete(this.completed.keys().next().value!)
    }
    return selectNativeChatFindMatch(documents, input)
  }

  dispose(): void {
    this.completed.clear()
    this.host.destroy()
    this.fail(new Error('Chat find stopped'))
  }

  private touchCompleted(): void {
    if (this.completedTimer) {
      clearTimeout(this.completedTimer)
    }
    this.completedTimer = setTimeout(() => {
      this.completedTimer = null
      this.completed.clear()
    }, FIND_IDLE_MS)
    unrefTimer(this.completedTimer)
  }

  private fail(error: Error): void {
    const calls = [...this.calls.values()]
    this.calls.clear()
    for (const call of calls) {
      call.onGone(error)
    }
  }

  private scan(
    agent: AgentType,
    filePath: string,
    version: string,
    size: number,
    query: string,
    signal?: AbortSignal
  ): Promise<NativeChatFindDocument[]> {
    const worker = this.host.ensure()
    if (!worker) {
      return Promise.reject(new Error('Chat find unavailable'))
    }
    this.host.clearIdleTimer()
    const id = ++this.nextId
    const post = (command: NativeChatTranscriptFindCommand, transfer?: ArrayBuffer[]): void =>
      worker.postMessage(command, transfer)
    let acked: (() => void) | null = null
    return new Promise<NativeChatFindDocument[]>((resolve, reject) => {
      const settle = (): void => {
        this.calls.delete(id)
        signal?.removeEventListener('abort', onAbort)
        if (this.calls.size === 0) {
          this.host.scheduleIdleTeardown()
        }
      }
      const onAbort = (): void => {
        settle()
        post({ type: 'cancel', id })
        acked?.()
        reject(signal!.reason)
      }
      const send = async (parts: Buffer[], length: number): Promise<void> => {
        // Pooled stream Buffers share memory; transfer a copy that owns exactly these bytes.
        const owned = new Uint8Array(length)
        let at = 0
        for (const part of parts) {
          owned.set(part, at)
          at += part.length
        }
        const ack = new Promise<void>((done) => {
          acked = done
        })
        post({ type: 'chunk', id, bytes: owned.buffer }, [owned.buffer])
        await ack
      }
      const feed = async (): Promise<void> => {
        const stream = openTranscriptReadStream(
          filePath,
          { start: 0, end: size - 1 },
          'exact',
          signal
        )
        let parts: Buffer[] = []
        let length = 0
        try {
          for await (const chunk of stream) {
            if (!this.calls.has(id)) {
              return
            }
            parts.push(chunk as Buffer)
            length += chunk.length
            if (length >= SEND_CHUNK_BYTES) {
              await send(parts, length)
              parts = []
              length = 0
            }
          }
        } finally {
          stream.destroy()
        }
        if (length > 0 && this.calls.has(id)) {
          await send(parts, length)
        }
        if (this.calls.has(id)) {
          post({ type: 'end', id })
        }
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.calls.set(id, {
        onResponse: (response) => {
          if (response.type === 'ack') {
            acked?.()
            return
          }
          if (response.type === 'need-bytes') {
            feed().catch((error: unknown) => {
              if (!this.calls.has(id)) {
                return
              }
              settle()
              post({ type: 'cancel', id })
              reject(error)
            })
            return
          }
          settle()
          if (response.type === 'done') {
            resolve(response.documents)
          } else {
            reject(new Error(response.error))
          }
        },
        onGone: (error) => {
          settle()
          acked?.()
          reject(error)
        }
      })
      post({ type: 'search', id, version, agent, filePath, query })
    })
  }
}

let shared: NativeChatTranscriptFind | null = null

export function nativeChatTranscriptFind(): NativeChatTranscriptFind {
  shared ??= new NativeChatTranscriptFind()
  return shared
}
