import { createHash, randomUUID } from 'node:crypto'
import type { z } from 'zod'
import { normalizePromptField } from '../../../shared/agent-status-field-normalization'
import type { canvasSendSchema, CanvasMessage } from '../../../shared/canvas-messaging'
import type { EnrichedAgentHookEventPayload } from '../../agent-hooks/server'
import type { CanvasMessageJournal } from './canvas-message-journal'
import {
  canvasMemberEpoch,
  type CanvasMember,
  type CanvasMessageMembership
} from './canvas-message-membership'
import { expectsCanvasReply } from './canvas-message-prompt'

type PendingReply = {
  message: CanvasMessage
  member: CanvasMember
  prompt: string
  startedAt: number
  observed: boolean
  requestId: string
  final?: { body: string; launchToken: string }
}

export class CanvasReplyRelay {
  private readonly pending = new Map<string, PendingReply>()
  constructor(
    private readonly journal: CanvasMessageJournal,
    private readonly membership: CanvasMessageMembership,
    private readonly send: (input: z.infer<typeof canvasSendSchema>) => CanvasMessage
  ) {}

  stop(): void {
    for (const entry of this.pending.values()) {
      this.cancel(
        entry.message.id,
        'Orca stopped tracking this reply. No terminal history will be forwarded after restart.'
      )
    }
  }

  assertAvailable(paneKey: string): void {
    this.flush()
    if (this.pending.has(paneKey)) {
      throw new Error('Waiting for the previous canvas request to finish.')
    }
  }

  arm(message: CanvasMessage, member: CanvasMember, prompt: string): void {
    if (expectsCanvasReply(message)) {
      this.pending.set(member.paneKey, {
        message,
        member,
        prompt: normalizePromptField(prompt),
        startedAt: Date.now(),
        observed: false,
        requestId: randomUUID()
      })
    }
  }

  cancel(messageId: string, detail: string): void {
    for (const [pane, entry] of this.pending) {
      if (entry.message.id !== messageId) {
        continue
      }
      this.pending.delete(pane)
      const current = this.journal.get(messageId)
      if (current && !this.hasReply(current)) {
        this.journal.update(current, current.state, detail)
      }
    }
  }

  observe(event: EnrichedAgentHookEventPayload): void {
    const entry = this.pending.get(event.paneKey)
    if (
      !entry ||
      entry.final ||
      event.isReplay ||
      event.restoredUnconfirmed ||
      event.connectionId !== null ||
      event.providerSessionOnly ||
      event.toolAgentId ||
      event.claudeLeadBoundaryChildOnly ||
      event.receivedAt < entry.startedAt
    ) {
      return
    }
    const member = entry.member
    if (
      event.worktreeId !== member.worktreeId ||
      event.source !== member.provider ||
      !event.launchToken ||
      event.providerSession?.id !== member.identity?.sessionId ||
      createHash('sha256').update(event.launchToken).digest('hex') !==
        member.identity?.launchTokenHash
    ) {
      return
    }
    if (
      event.payload.interrupted ||
      event.payload.sessionBoundary ||
      event.payload.prompt !== entry.prompt
    ) {
      this.cancel(
        entry.message.id,
        'Reply tracking stopped: the agent was interrupted or moved to another prompt. No unrelated answer was forwarded.'
      )
      return
    }
    if (
      event.hasExplicitPrompt &&
      ['UserPromptSubmit', 'beforeSubmitPrompt'].includes(event.hookEventName ?? '')
    ) {
      if (entry.observed) {
        this.cancel(entry.message.id, 'Another prompt started. Reply correlation is unverifiable.')
        return
      }
      entry.observed = true
    }
    if (
      !entry.observed ||
      event.payload.state !== 'done' ||
      !['Stop', 'stop', 'afterAgentResponse'].includes(event.hookEventName ?? '') ||
      event.payload.lastAssistantMessageIsToolOutput
    ) {
      return
    }
    const body = event.payload.lastAssistantMessage?.trim()
    if (!body) {
      return
    }
    entry.final = { body, launchToken: event.launchToken }
    this.flush()
  }

  flush(): void {
    // Sending may reinsert a held reply; only visit the entries present at the start.
    const snapshot = [...this.pending]
    for (const [pane, entry] of snapshot) {
      const message = this.journal.get(entry.message.id)
      if (!message || this.hasReply(message)) {
        this.pending.delete(pane)
        continue
      }
      if (
        Date.now() - entry.startedAt > 30 * 60_000 ||
        !['sending', 'delivered', 'received'].includes(message.state)
      ) {
        this.cancel(
          message.id,
          'Automatic reply tracking expired or delivery is unverifiable. No later terminal response will be forwarded.'
        )
        continue
      }
      try {
        const pair = this.membership.connected(message.canvasId, message.source, message.target)
        if (
          canvasMemberEpoch(pair[0]) !== message.sourceEpoch ||
          canvasMemberEpoch(pair[1]) !== message.targetEpoch
        ) {
          this.cancel(message.id, 'Reply tracking stopped because the connected session changed.')
          continue
        }
        if (!entry.final || pair.some((member) => member.collaborationPaused)) {
          continue
        }
        this.pending.delete(pane)
        try {
          this.send({
            paneKey: pane,
            launchToken: entry.final.launchToken,
            canvasId: message.canvasId,
            to: message.source,
            body: entry.final.body,
            kind: 'reply',
            replyTo: message.id,
            requestId: entry.requestId
          })
          const answered = this.journal.get(message.id)!
          this.journal.update(
            answered,
            answered.state,
            'The final answer was returned automatically from the matching agent turn.'
          )
        } catch (error) {
          this.pending.set(pane, entry)
          this.journal.update(
            message,
            message.state,
            `Final answer captured; return is pending: ${error instanceof Error ? error.message : 'unverifiable'}`
          )
        }
      } catch {
        this.cancel(message.id, 'Reply tracking stopped because the connection was removed.')
      }
    }
  }

  private hasReply(message: CanvasMessage): boolean {
    return this.journal
      .history(message.canvasId)
      .some((candidate) => candidate.replyTo === message.id)
  }
}
