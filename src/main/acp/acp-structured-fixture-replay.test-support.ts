// Plays a recorded Grok session back as the agent behind the real adapter. Orca's own frames
// advance the recording: the agent's lines after each one are sent until the recording waits on
// Orca again. The recording's prompt ids and session id are rewritten to the ones this run uses,
// as the real agent echoes the prompt id it was sent.

import { expect } from 'vitest'
import { z } from 'zod'
import type { AcpFixtureFrame } from './acp-timeline-fixture.test-support'
import type { AcpScriptedAgent, FakeFrame } from './acp-scripted-agent.test-support'
import { PROVIDER_SESSION } from './acp-structured-adapter.test-support'

/** Recordings name their sessions `session-N`; a replay plays them all as this run's one. */
const RECORDED_SESSION = /"session-\d+"/g
const promptMetaSchema = z.object({ _meta: z.object({ promptId: z.string() }) })
const messageSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z
    .object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
    .optional()
})

function promptIdOf(params: unknown): string | undefined {
  return promptMetaSchema.safeParse(params).data?._meta.promptId
}

export class GrokFixtureReplay {
  private cursor = 0
  private agent: AcpScriptedAgent | null = null
  private readonly promptIds = new Map<string, string>()
  private readonly requestIds = new Map<string | number, string | number | null | undefined>()

  constructor(private readonly frames: AcpFixtureFrame[]) {}

  attach(agent: AcpScriptedAgent): void {
    this.agent = agent
    agent.on('session/prompt', (frame) => this.orcaSent('session/prompt', frame))
    agent.on('session/cancel', (frame) => this.orcaSent('session/cancel', frame))
  }

  /** What the recording waits for Orca to send next; null once it has played to the end. */
  get awaiting(): string | null {
    const next = this.frames[this.cursor]
    if (!next) {
      return null
    }
    return next.direction === 'out' ? (next.message.method ?? 'reply') : 'agent'
  }

  private orcaSent(method: string, frame: FakeFrame): void {
    const recorded = this.frames[this.cursor]
    expect(recorded?.direction).toBe('out')
    expect(recorded?.message.method).toBe(method)
    if (method === 'session/prompt' && recorded) {
      const recordedId = promptIdOf(recorded.message.params)
      const sentId = promptIdOf(frame.params)
      if (recordedId && sentId) {
        this.promptIds.set(recordedId, sentId)
      }
      this.requestIds.set(recorded.message.id ?? '', frame.id)
    }
    this.cursor += 1
    this.play()
  }

  private play(): void {
    const agent = this.agent
    while (agent && this.frames[this.cursor]?.direction === 'in') {
      const recorded = this.frames[this.cursor]!
      this.cursor += 1
      const message = this.rewrite(recorded.message)
      if (message.method !== undefined && message.id !== undefined) {
        // The agent asks Orca something; the recording resumes once Orca answers it.
        void agent.request(message.id, message.method, message.params).then(() => {
          expect(this.frames[this.cursor]?.direction).toBe('out')
          this.cursor += 1
          this.play()
        })
        return
      }
      if (message.method !== undefined) {
        agent.notify(message.method, message.params)
      } else {
        agent.send({
          jsonrpc: '2.0',
          id: this.requestIds.get(message.id ?? '') ?? message.id,
          ...(message.error === undefined ? { result: message.result } : { error: message.error })
        })
      }
    }
  }

  private rewrite(message: AcpFixtureFrame['message']): z.infer<typeof messageSchema> {
    let text = JSON.stringify(message).replaceAll(
      RECORDED_SESSION,
      JSON.stringify(PROVIDER_SESSION)
    )
    for (const [recorded, sent] of this.promptIds) {
      text = text.replaceAll(JSON.stringify(recorded), JSON.stringify(sent))
    }
    return messageSchema.parse(JSON.parse(text))
  }
}
