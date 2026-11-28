/** The minimal ZCode chat session manager: one foreground `zcode -p` process per turn, its JSONL
 *  stream translated to timeline events, the provider's `sess_...` kept, and the running process
 *  killed on cancel. A follow-up turn passes `--resume <sess_...>`. There is no long-lived pipe:
 *  the provider process exists only while a turn runs. */

import type { AgentSessionDispatchOutcome } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { ProviderProcessLaunch } from '../../provider-process/provider-process-launch'
import { ZcodeTimelineTranslator } from './zcode-timeline'
import { ZcodeTurnProcess } from './zcode-turn-process'
import type { ZcodeStreamRecord } from './zcode-stream-records'

export type ZcodeTurnRequest = {
  clientMessageId: string
  prompt: string
  requestedAt: number
  /** Chat option picks, passed only when the provider's CLI accepts them. */
  model?: string
  effort?: string
}

export type ZcodeChatSessionHandlers = {
  onEvents: (events: readonly ProviderTimelineEvent[]) => void
  /** A turn that failed after admission needs a late settlement; a completed turn is settled by
   *  its journal `turn.end` row and reports nothing here. */
  onTurnSettled: (input: { clientMessageId: string; outcome: AgentSessionDispatchOutcome }) => void
  /** The provider's own conversation id, first seen mid-stream; feeds the resume handle. */
  onProviderSessionId: (nativeId: string) => void
  onError: (error: Error) => void
}

export type ZcodeChatSessionLaunch = {
  command: string
  prefixArgs: readonly string[]
  cwd: string
  env?: Record<string, string>
  envToDelete?: readonly string[]
}

/** One running turn process; injectable so a test drives the session without a child. */
export type ZcodeTurnHandle = {
  done: Promise<{ sessionId: string | null; response: string | null }>
  abort(): void
}

export type ZcodeStartTurn = (
  launch: ProviderProcessLaunch,
  onRecord: (record: ZcodeStreamRecord) => void
) => ZcodeTurnHandle

/** Building the argv is pure so a test can assert the resume and option mapping without a child. */
export function zcodeTurnArgs(input: {
  prompt: string
  cwd: string
  prefixArgs?: readonly string[]
  resumeId?: string | null
  model?: string
  effort?: string
}): string[] {
  const args = [...(input.prefixArgs ?? []), '-p', input.prompt, '--output-format', 'stream-json']
  args.push('--cwd', input.cwd)
  if (input.resumeId) {
    args.push('--resume', input.resumeId)
  }
  if (input.model) {
    args.push('--model', input.model)
  }
  if (input.effort) {
    args.push('--effort', input.effort)
  }
  return args
}

export class ZcodeChatSession {
  private readonly translator = new ZcodeTimelineTranslator()
  private running: { clientMessageId: string; turnId: string; process: ZcodeTurnHandle } | null =
    null
  private providerSessionId: string
  private turn = 0
  private closed = false
  private readonly startTurn: ZcodeStartTurn

  constructor(
    private readonly launch: ZcodeChatSessionLaunch,
    private readonly handlers: ZcodeChatSessionHandlers,
    resumeId: string | null,
    startTurn?: ZcodeStartTurn
  ) {
    this.providerSessionId = resumeId ?? ''
    this.startTurn = startTurn ?? ((launch, onRecord) => new ZcodeTurnProcess(launch, onRecord))
  }

  get resumeId(): string | null {
    return this.providerSessionId.length > 0 ? this.providerSessionId : null
  }

  get busy(): boolean {
    return this.running !== null
  }

  async submit(request: ZcodeTurnRequest): Promise<AgentSessionDispatchOutcome> {
    if (this.closed) {
      return { state: 'unknown', reason: 'ZCode chat is closed' }
    }
    if (this.running) {
      return { state: 'unknown', reason: 'ZCode is already answering this chat' }
    }
    const turnId = `zcode-turn-${++this.turn}`
    const launch: ProviderProcessLaunch = {
      command: this.launch.command,
      args: zcodeTurnArgs({
        prompt: request.prompt,
        cwd: this.launch.cwd,
        prefixArgs: this.launch.prefixArgs,
        resumeId: this.resumeId,
        ...(request.model ? { model: request.model } : {}),
        ...(request.effort ? { effort: request.effort } : {})
      }),
      cwd: this.launch.cwd,
      ...(this.launch.env ? { env: this.launch.env } : {}),
      ...(this.launch.envToDelete ? { envToDelete: this.launch.envToDelete } : {})
    }
    const process = this.startTurn(launch, this.onRecord)
    this.running = { clientMessageId: request.clientMessageId, turnId, process }
    this.handlers.onEvents(
      this.translator.beginTurn({
        clientMessageId: request.clientMessageId,
        requestedAt: request.requestedAt,
        turnId
      })
    )
    void process.done.then(
      (completion) => this.finish(request.clientMessageId, turnId, completion.response, null),
      (error: unknown) =>
        this.finish(
          request.clientMessageId,
          turnId,
          null,
          error instanceof Error ? error : new Error(String(error))
        )
    )
    return { state: 'admitted' }
  }

  private readonly onRecord = (record: ZcodeStreamRecord): void => {
    const providerSessionId = record.sessionId ?? record.payload?.sessionId
    if (typeof providerSessionId === 'string' && providerSessionId !== this.providerSessionId) {
      this.providerSessionId = providerSessionId
      this.handlers.onProviderSessionId(providerSessionId)
    }
    const events = this.translator.frame(record)
    if (events) {
      this.handlers.onEvents(events)
    }
  }

  cancel(): void {
    this.running?.process.abort()
  }

  close(): void {
    this.closed = true
    this.running?.process.abort()
  }

  private finish(
    clientMessageId: string,
    turnId: string,
    response: string | null,
    failure: Error | null
  ): void {
    if (this.running?.turnId !== turnId) {
      return
    }
    this.running = null
    this.handlers.onEvents(
      this.translator.finish({ turnId, at: Date.now(), response, interrupted: failure !== null })
    )
    if (failure) {
      this.handlers.onError(failure)
      this.handlers.onTurnSettled({
        clientMessageId,
        outcome: { state: 'unknown', reason: failure.message }
      })
    }
  }
}
