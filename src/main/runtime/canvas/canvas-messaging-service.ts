import type { z } from 'zod'
import type { canvasSendSchema, CanvasMessage } from '../../../shared/canvas-messaging'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { CanvasMessageJournal } from './canvas-message-journal'
import type { CanvasMessageMembership } from './canvas-message-membership'
import { canvasMemberEpoch } from './canvas-message-membership'
import type { EnrichedAgentHookEventPayload } from '../../agent-hooks/server'
import { CanvasReplyRelay } from './canvas-reply-relay'
import { canvasMessagePrompt } from './canvas-message-prompt'

export class CanvasMessagingService {
  private flushing = false
  private stopped = false
  private readonly replies: CanvasReplyRelay
  observeAgentHook(event: EnrichedAgentHookEventPayload): void {
    if (!this.stopped) {
      this.replies.observe(event)
    }
  }
  stop(): void {
    this.stopped = true
    this.replies.stop()
  }
  constructor(
    readonly journal: CanvasMessageJournal,
    readonly membership: CanvasMessageMembership,
    private readonly runtime: OrcaRuntimeService,
    private readonly cliCommand: () => string | null
  ) {
    this.replies = new CanvasReplyRelay(journal, membership, (input) => this.send(input))
  }

  peers(paneKey: string, launchToken: string) {
    return [...this.membership.contexts.snapshot().keys()].flatMap((canvasId) => {
      if (!this.membership.members(canvasId).some((member) => member.paneKey === paneKey)) {
        return []
      }
      const actor = this.membership.actor(canvasId, paneKey, launchToken)
      return [
        {
          canvasId,
          self: actor.nodeId,
          paused: actor.collaborationPaused === true,
          peers: this.membership
            .members(canvasId)
            .filter(
              (peer) => actor.peers?.includes(peer.nodeId) && peer.peers?.includes(actor.nodeId)
            )
            .map((peer) => ({
              id: peer.nodeId,
              name: peer.name ?? peer.nodeId,
              provider: peer.provider,
              worktreeId: peer.worktreeId
            }))
        }
      ]
    })
  }

  send(input: z.infer<typeof canvasSendSchema>): CanvasMessage {
    const actor = this.membership.actor(input.canvasId, input.paneKey, input.launchToken)
    const [from, to] = this.membership.connected(input.canvasId, actor.nodeId, input.to)
    const id = `canvas_msg_${input.requestId}`
    const previous = this.journal.get(id)
    if (previous) {
      if (
        previous.canvasId !== input.canvasId ||
        previous.source !== from.nodeId ||
        previous.target !== to.nodeId ||
        previous.sourceEpoch !== canvasMemberEpoch(from) ||
        previous.targetEpoch !== canvasMemberEpoch(to) ||
        previous.body !== input.body ||
        previous.replyTo !== (input.replyTo ?? null) ||
        previous.kind !== (input.replyTo ? 'reply' : input.kind)
      ) {
        throw new Error('The request ID was already used for another message.')
      }
      return previous
    }
    if (from.collaborationPaused || to.collaborationPaused) {
      throw new Error('Canvas collaboration is paused.')
    }
    this.membership.live(to)
    const now = Date.now()
    if (this.journal.count(input.canvasId, now - 60_000) >= 20) {
      throw new Error('Canvas message rate limit reached. Wait a minute before sending more.')
    }
    if (this.journal.count(input.canvasId, 0) >= 500) {
      throw new Error('Canvas message history is full. Start a new canvas for more conversations.')
    }
    const original = input.replyTo ? this.journal.get(input.replyTo) : undefined
    if (
      input.replyTo &&
      (!original ||
        original.canvasId !== input.canvasId ||
        original.target !== from.nodeId ||
        original.source !== to.nodeId ||
        original.targetEpoch !== canvasMemberEpoch(from) ||
        original.sourceEpoch !== canvasMemberEpoch(to))
    ) {
      throw new Error('The reply does not belong to these agent sessions.')
    }
    if (!input.replyTo && input.kind === 'reply') {
      throw new Error('A reply needs --reply-to.')
    }
    if (
      original &&
      this.journal
        .history(input.canvasId)
        .filter((message) => message.threadId === original.threadId).length >= 8
    ) {
      throw new Error(
        'This conversation reached its 8-message limit. Ask the user before starting more work.'
      )
    }
    const message = this.journal.insert({
      id,
      canvasId: input.canvasId,
      source: from.nodeId,
      target: to.nodeId,
      sourceEpoch: canvasMemberEpoch(from),
      targetEpoch: canvasMemberEpoch(to),
      sourceName: from.name ?? from.nodeId,
      targetName: to.name ?? to.nodeId,
      kind: original ? 'reply' : input.kind,
      body: input.body,
      replyTo: original?.id ?? null,
      threadId: original?.threadId ?? id,
      state: 'queued',
      detail: '',
      createdAt: now
    })
    if (original) {
      this.journal.update(original, 'received', 'The recipient replied to this message.')
    }
    void this.flush()
    return message
  }

  inbox(canvasId: string, paneKey: string, launchToken: string): CanvasMessage[] {
    const actor = this.membership.actor(canvasId, paneKey, launchToken)
    const messages = this.journal
      .history(canvasId)
      .filter(
        (message) =>
          message.target === actor.nodeId &&
          message.targetEpoch === canvasMemberEpoch(actor) &&
          ['queued', 'delivered'].includes(message.state)
      )
      .filter((message) => {
        try {
          const pair = this.membership.connected(canvasId, message.source, message.target)
          return (
            !pair.some((member) => member.collaborationPaused) &&
            canvasMemberEpoch(pair[0]) === message.sourceEpoch
          )
        } catch {
          return false
        }
      })
    for (const message of messages) {
      this.journal.update(
        message,
        'received',
        'Returned to the recipient CLI; not proof of model comprehension.'
      )
    }
    return messages.map((message) => ({ ...message, state: 'received' as const }))
  }

  async flush(): Promise<void> {
    if (this.flushing || this.stopped) {
      return
    }
    this.flushing = true
    try {
      this.replies.flush()
      for (const message of this.journal.pending()) {
        await this.deliver(message)
      }
    } catch {
      // The durable queue remains available after runtime teardown or loss of contact.
    } finally {
      this.flushing = false
    }
  }

  private async deliver(message: CanvasMessage): Promise<void> {
    if (this.journal.get(message.id)?.state !== 'queued') {
      return
    }
    let pair: ReturnType<CanvasMessageMembership['connected']>
    try {
      pair = this.membership.connected(message.canvasId, message.source, message.target)
    } catch {
      this.journal.update(message, 'cancelled', 'The connection or agent was removed.')
      return
    }
    if (pair[0].collaborationPaused || pair[1].collaborationPaused) {
      this.journal.update(message, 'queued', 'Collaboration is paused.')
      return
    }
    if (
      canvasMemberEpoch(pair[0]) !== message.sourceEpoch ||
      canvasMemberEpoch(pair[1]) !== message.targetEpoch
    ) {
      this.journal.update(message, 'cancelled', 'The connected session changed.')
      return
    }
    if (Date.now() - message.createdAt > 30 * 60_000) {
      this.journal.update(message, 'cancelled', 'Message expired after 30 minutes.')
      return
    }
    let staged = false
    try {
      const command = this.cliCommand()
      if (!command) {
        throw new Error('This instance’s CLI is unavailable.')
      }
      const handle = this.membership.live(pair[1])
      this.membership.live(pair[0])
      const ready = async () => {
        this.replies.assertAvailable(pair[1].paneKey)
        if (this.stopped) {
          throw new Error('Runtime is shutting down.')
        }
        const members = this.membership.connected(message.canvasId, message.source, message.target)
        if (
          members.some((member) => member.collaborationPaused) ||
          canvasMemberEpoch(members[0]) !== message.sourceEpoch ||
          canvasMemberEpoch(members[1]) !== message.targetEpoch
        ) {
          throw new Error('Collaboration paused or session changed.')
        }
        this.membership.live(members[1])
        this.membership.live(members[0])
        const status = await this.runtime.getTerminalAgentStatus(handle)
        if (!status.isRunningAgent || status.status !== 'idle') {
          throw new Error('Waiting for the agent to become idle.')
        }
        const screen = await this.runtime.readTerminal(handle, { screen: true, limit: 30 })
        if (screen.source !== 'screen' || screen.composerReady !== true || screen.draft?.trim()) {
          throw new Error('Waiting for an available terminal with no draft.')
        }
      }
      await ready()
      if (this.journal.get(message.id)?.state !== 'queued') {
        return
      }
      const prompt = canvasMessagePrompt(message, command)
      this.journal.update(message, 'sending')
      await this.runtime.sendTerminalAgentPrompt(handle, prompt, {
        beforeWrite: async () => {
          if (!staged) {
            await ready()
            if (this.journal.get(message.id)?.state !== 'sending') {
              throw new Error('Message was already retrieved.')
            }
            staged = true
          } else {
            if (this.stopped) {
              throw new Error('Runtime is shutting down.')
            }
            const members = this.membership.connected(
              message.canvasId,
              message.source,
              message.target
            )
            if (
              members.some((member) => member.collaborationPaused) ||
              canvasMemberEpoch(members[0]) !== message.sourceEpoch ||
              canvasMemberEpoch(members[1]) !== message.targetEpoch
            ) {
              throw new Error('Connection changed during delivery.')
            }
            this.membership.live(members[1])
            this.membership.live(members[0])
            this.replies.arm(message, members[1], prompt)
          }
        }
      })
      const submitted = this.journal.get(message.id)
      if (submitted?.state === 'sending') {
        this.journal.update(
          submitted,
          'delivered',
          submitted.detail || 'Submitted to the agent terminal; awaiting its response.'
        )
      }
    } catch (error) {
      if (!['queued', 'sending'].includes(this.journal.get(message.id)?.state ?? '')) {
        return
      }
      this.journal.update(
        message,
        staged ? 'unverifiable' : 'queued',
        error instanceof Error ? error.message : 'Delivery is unverifiable.'
      )
      this.replies.cancel(
        message.id,
        'Automatic reply tracking stopped because delivery is unverifiable.'
      )
    }
  }
}
