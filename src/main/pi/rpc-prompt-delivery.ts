import { agentSessionFailureFact, providerDiagnostic } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'
import { piRpcPromptReplySchema } from './rpc-protocol'

type Submission = {
  id: string
  at: number
  frame?: JsonlRpcRecord
  bytes: number
  accepted: boolean
  retries: number
}
type DeliveryDeps = {
  send: (frame: JsonlRpcRecord) => Promise<void>
  accepted: (id: string, at: number) => void
  commandOnly: () => void
  rejectedAfterAcceptance: (error: string) => void
  settled: (id: string, outcome: AgentSessionDispatchOutcome) => void
  failed: (error: Error) => void
  beforeWrite?: () => void
  refused?: () => void
}

/** Idless prompt acknowledgements are FIFO and may wait indefinitely on extension dialogs. */
export function piRpcFailureFact(error: string) {
  return agentSessionFailureFact(
    error.startsWith('No API key found for ') ? 'notSignedIn' : 'providerRejected',
    { detail: providerDiagnostic(error, 'person') }
  )
}

export class PiRpcPromptDelivery {
  private readonly acknowledgements: Submission[] = []
  private readonly waiting: Submission[] = []
  private readonly retries = new Set<ReturnType<typeof setTimeout>>()
  private readonly pending = new Set<Submission>()
  private heldBytes = 0
  private ended = false
  constructor(private readonly deps: DeliveryDeps) {}
  get holdsDispatch(): boolean {
    return this.waiting.length > 0 || this.retries.size > 0
  }

  async submit(
    id: string,
    at: number,
    frame: JsonlRpcRecord,
    before?: () => Promise<void>
  ): Promise<AgentSessionDispatchOutcome> {
    if (this.ended) {
      throw new Error('Pi prompt queue unavailable')
    }
    const bytes = Buffer.byteLength(JSON.stringify(frame))
    if (this.pending.size >= 128 || this.heldBytes + bytes > 32 * 1024 * 1024) {
      return {
        state: 'rejected',
        ...agentSessionFailureWords(agentSessionFailureFact('queueFull'), {
          agentName: 'Pi',
          surface: 'rejection'
        })
      }
    }
    const submission: Submission = { id, at, frame, bytes, accepted: false, retries: 0 }
    this.pending.add(submission)
    this.heldBytes += bytes
    try {
      await before?.()
      if (this.ended) {
        throw new Error('Pi ended before writing the prompt')
      }
      this.deps.beforeWrite?.()
      this.acknowledgements.push(submission)
      this.waiting.push(submission)
      await this.deps.send(frame)
      return { state: 'admitted' }
    } catch {
      this.remove(submission)
      this.deps.refused?.()
      return { state: 'unknown', reason: 'Pi prompt write did not settle' }
    }
  }

  consumeNext(): boolean {
    const submission = this.waiting[0]
    if (!submission) {
      return false
    }
    this.accept(submission)
    return true
  }

  reply(frame: JsonlRpcRecord): void {
    const reply = piRpcPromptReplySchema.parse(frame)
    const submission = this.acknowledgements.shift()
    if (!submission) {
      throw new Error('Pi prompt reply has no request')
    }
    if (!reply.success) {
      const fact = piRpcFailureFact(reply.error ?? 'Pi rejected the prompt')
      if (!submission.accepted && fact.kind === 'notSignedIn' && submission.retries++ < 8) {
        this.removeWaiting(submission)
        const timer = setTimeout(() => {
          this.retries.delete(timer)
          if (this.ended) {
            return
          }
          const frame = submission.frame
          if (!frame) {
            this.deps.failed(new Error('Pi retry lost its unaccepted prompt'))
            return
          }
          this.acknowledgements.push(submission)
          this.waiting.push(submission)
          void this.deps
            .send(frame)
            .catch((error: unknown) =>
              this.deps.failed(error instanceof Error ? error : new Error(String(error)))
            )
        }, 250)
        timer.unref()
        this.retries.add(timer)
        return
      }
      this.remove(submission)
      this.deps.settled(submission.id, {
        state: 'rejected',
        ...agentSessionFailureWords(fact, { agentName: 'Pi', surface: 'rejection' })
      })
      if (submission.accepted) {
        this.deps.rejectedAfterAcceptance(reply.error ?? 'Pi rejected the prompt')
      } else {
        this.deps.refused?.()
      }
      return
    }
    this.releaseFrame(submission)
    if (reply.data?.disposition === 'handled' || reply.data?.agentInvoked === false) {
      this.accept(submission)
      this.deps.commandOnly()
    }
    this.finishIfConsumed(submission)
  }

  end(): void {
    this.ended = true
    for (const timer of this.retries) {
      clearTimeout(timer)
    }
    this.retries.clear()
    for (const submission of this.pending) {
      if (!submission.accepted) {
        this.deps.settled(submission.id, {
          state: 'unknown',
          reason: 'Pi ended before confirming delivery'
        })
      }
      this.releaseFrame(submission)
    }
    this.waiting.length = 0
    this.acknowledgements.length = 0
    this.pending.clear()
  }

  private accept(submission: Submission): void {
    if (submission.accepted) {
      return
    }
    submission.accepted = true
    this.removeWaiting(submission)
    this.releaseFrame(submission)
    this.finishIfConsumed(submission)
    this.deps.accepted(submission.id, submission.at)
  }
  private remove(submission: Submission): void {
    for (const list of [this.waiting, this.acknowledgements]) {
      const index = list.indexOf(submission)
      if (index !== -1) {
        list.splice(index, 1)
      }
    }
    this.releaseFrame(submission)
    this.pending.delete(submission)
  }
  private removeWaiting(submission: Submission): void {
    const index = this.waiting.indexOf(submission)
    if (index !== -1) {
      this.waiting.splice(index, 1)
    }
  }
  private releaseFrame(submission: Submission): void {
    if (submission.frame) {
      this.heldBytes -= submission.bytes
      submission.frame = undefined
    }
  }
  private finishIfConsumed(submission: Submission): void {
    if (!this.waiting.includes(submission) && !this.acknowledgements.includes(submission)) {
      this.pending.delete(submission)
    }
  }
}
