import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'

/** How long a pane counts as reachable after its plugin last polled; it polls every second. */
export const CLAUDE_TERMINAL_MAIL_LIVE_MS = 5000
/** A submission the plugin never took is safe to hand back; one it took has no proven outcome. */
const UNTAKEN_TIMEOUT_MS = 5000
const TAKEN_TIMEOUT_MS = 30_000

const Identity = z.object({
  paneKey: z
    .string()
    .max(256)
    .refine((value) => parsePaneKey(value) !== null),
  sessionId: z.string().min(1).max(256),
  instanceId: z.string().min(1).max(256)
})
const Message = z.discriminatedUnion('action', [
  Identity.extend({ action: z.literal('poll') }),
  Identity.extend({
    action: z.literal('ack'),
    id: z.string().max(64),
    submitted: z.boolean()
  }),
  Identity.extend({ action: z.literal('end') })
])

/** `refused`: the prompt never reached Claude, so the mail may go another way; `unverifiable`: it may have. */
export type ClaudeTerminalMailOutcome = 'submitted' | 'refused' | 'unverifiable'

type Submission = {
  id: string
  text: string
  taken: boolean
  finish: (outcome: ClaudeTerminalMailOutcome) => void
}

type MailSession = z.infer<typeof Identity> & { seenAt: number; outbox: Submission[] }

/** Claude terminals whose Orca plugin takes prompts as turns of their own, keyed by pane, so
 *  orchestration mail reaches them without typing into the terminal. */
export class ClaudeTerminalMailBridge {
  private readonly sessions = new Map<string, MailSession>()
  private readonly liveListeners = new Set<(paneKey: string) => void>()

  /** Called when a pane's plugin first polls, so mail waiting for it can be sent through it. */
  onLive(listener: (paneKey: string) => void): () => void {
    this.liveListeners.add(listener)
    return () => this.liveListeners.delete(listener)
  }

  isLive(paneKey: string): boolean {
    const session = this.sessions.get(paneKey)
    return !!session && Date.now() - session.seenAt <= CLAUDE_TERMINAL_MAIL_LIVE_MS
  }

  receive(body: unknown): { submissions?: { id: string; text: string }[] } {
    const parsed = Message.safeParse(body)
    if (!parsed.success) {
      return {}
    }
    const message = parsed.data
    let session = this.sessions.get(message.paneKey)
    const same =
      session?.sessionId === message.sessionId && session.instanceId === message.instanceId
    if (message.action === 'poll') {
      if (!same) {
        if (!session && this.sessions.size >= 1024) {
          this.pruneStale()
          if (this.sessions.size >= 1024) {
            return {}
          }
        }
        this.drop(message.paneKey)
        session = { ...message, seenAt: Date.now(), outbox: [] }
        this.sessions.set(message.paneKey, session)
        for (const listener of this.liveListeners) {
          listener(message.paneKey)
        }
      }
      if (!session) {
        return {}
      }
      session.seenAt = Date.now()
      const fresh = session.outbox.filter((submission) => !submission.taken)
      for (const submission of fresh) {
        submission.taken = true
      }
      return { submissions: fresh.map(({ id, text }) => ({ id, text })) }
    }
    if (!same || !session) {
      return {}
    }
    if (message.action === 'end') {
      this.drop(message.paneKey)
      return {}
    }
    const submission = session.outbox.find((item) => item.id === message.id && item.taken)
    submission?.finish(message.submitted ? 'submitted' : 'refused')
    return {}
  }

  /** Hands `text` to the pane's plugin, which submits it as a turn of its own once Claude is idle. */
  submit(paneKey: string, text: string): Promise<ClaudeTerminalMailOutcome> {
    const session = this.sessions.get(paneKey)
    if (!session || !this.isLive(paneKey)) {
      return Promise.resolve('refused')
    }
    return new Promise((resolve) => {
      const submission: Submission = {
        id: randomUUID(),
        text,
        taken: false,
        finish: (outcome) => {
          clearTimeout(untaken)
          clearTimeout(taken)
          session.outbox = session.outbox.filter((item) => item !== submission)
          resolve(outcome)
        }
      }
      const untaken = setTimeout(() => {
        if (!submission.taken) {
          submission.finish('refused')
        }
      }, UNTAKEN_TIMEOUT_MS)
      const taken = setTimeout(() => submission.finish('unverifiable'), TAKEN_TIMEOUT_MS)
      untaken.unref?.()
      taken.unref?.()
      session.outbox.push(submission)
    })
  }

  clear(): void {
    for (const paneKey of this.sessions.keys()) {
      this.drop(paneKey)
    }
  }

  /** A Claude that exited without `end` (its terminal closed under it) stops polling; forget it. */
  private pruneStale(): void {
    for (const [paneKey, session] of this.sessions) {
      if (Date.now() - session.seenAt > 3 * CLAUDE_TERMINAL_MAIL_LIVE_MS) {
        this.drop(paneKey)
      }
    }
  }

  /** A prompt the plugin never took never reached Claude; one it took may have. */
  private drop(paneKey: string): void {
    const session = this.sessions.get(paneKey)
    if (!session) {
      return
    }
    this.sessions.delete(paneKey)
    for (const submission of session.outbox) {
      submission.finish(submission.taken ? 'unverifiable' : 'refused')
    }
  }
}
