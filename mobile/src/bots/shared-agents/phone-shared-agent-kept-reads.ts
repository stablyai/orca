// What the phone answers for a shared agent's host while it is away: the host's last answer to each
// read a page opens with (its status, its row, its chat list), and each chat's transcript stream
// since its last snapshot. Kept in memory for the launch, as Home keeps a computer's last list.
import { z } from 'zod'
import type { RpcResponse } from '../../../../src/shared/remote-runtime/rpc/rpc-response-shape'

const KEPT_READS: ReadonlySet<string> = new Set(['status.get', 'bots.list', 'bots.chatTree'])
const TRANSCRIPT_METHOD = 'agentSession.subscribe'
// A chat streamed past this many events since its snapshot isn't kept, rather than grow all launch.
const MAX_TRANSCRIPT_EVENTS = 500

const SessionParams = z.looseObject({ sessionId: z.string() })
const StreamEvent = z.looseObject({ type: z.string() })

export class PhoneSharedAgentKeptReads {
  private readonly answers = new Map<string, RpcResponse>()
  private readonly transcripts = new Map<string, unknown[]>()

  /** The host's last answer to this read, for while it is away. */
  answer(shareId: string, method: string, params: unknown): RpcResponse | undefined {
    return this.answers.get(readKey(shareId, method, params))
  }

  noteAnswer(shareId: string, method: string, params: unknown, response: RpcResponse): void {
    if (KEPT_READS.has(method) && response.ok) {
      this.answers.set(readKey(shareId, method, params), response)
    }
  }

  /** `onData`, keeping a live transcript stream's events as they pass. */
  recording(
    shareId: string,
    method: string,
    params: unknown,
    onData: (data: unknown) => void
  ): (data: unknown) => void {
    const key = transcriptKey(shareId, method, params)
    if (key === null) {
      return onData
    }
    return (data) => {
      const type = StreamEvent.safeParse(data).data?.type
      const kept = this.transcripts.get(key)
      if (type === 'snapshot') {
        this.transcripts.set(key, [data])
      } else if (type === 'reset' || (kept && kept.length >= MAX_TRANSCRIPT_EVENTS)) {
        this.transcripts.delete(key)
      } else if (type === 'batch' && kept) {
        kept.push(data)
      }
      onData(data)
    }
  }

  /** Streams the chat's kept transcript to `onData`; null when none is kept, else its stop. */
  replay(
    shareId: string,
    method: string,
    params: unknown,
    onData: (data: unknown) => void
  ): (() => void) | null {
    const key = transcriptKey(shareId, method, params)
    const kept = key === null ? undefined : this.transcripts.get(key)
    if (!kept) {
      return null
    }
    const events = [...kept]
    let stopped = false
    void Promise.resolve().then(() => {
      for (const event of events) {
        if (stopped) {
          return
        }
        onData(event)
      }
    })
    return () => {
      stopped = true
    }
  }

  /** Drops what was kept for a share this phone no longer has. */
  forget(shareId: string): void {
    for (const store of [this.answers, this.transcripts]) {
      for (const key of store.keys()) {
        if (key.startsWith(`${shareId}\0`)) {
          store.delete(key)
        }
      }
    }
  }
}

function readKey(shareId: string, method: string, params: unknown): string {
  return `${shareId}\0${method}\0${JSON.stringify(params ?? null)}`
}

function transcriptKey(shareId: string, method: string, params: unknown): string | null {
  const sessionId = SessionParams.safeParse(params).data?.sessionId
  return method === TRANSCRIPT_METHOD && sessionId ? `${shareId}\0${sessionId}` : null
}
