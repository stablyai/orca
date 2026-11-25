import { botGroupCompletedReply } from '../../shared/bots/bot-group-completed-reply'
import {
  BotGroupLatestSchema,
  BotGroupMessageSchema,
  botGroupTurnReplyText,
  type BotGroup,
  type BotGroupMessage
} from '../../shared/bots/bot-group-schema'

export const BOT_GROUP_LISTING_SQL = `
  SELECT group_id, sidebar_order, latest, NULL AS sequence, NULL AS record FROM bot_group_sidebar
  UNION ALL
  SELECT post.group_id, NULL, NULL, post.sequence, post.record
  FROM json_each(?) missing JOIN bot_group_messages post ON post.group_id = missing.value
  WHERE coalesce(json_extract(post.record, '$.threadId'), '') = ''
    AND (EXISTS (SELECT 1 FROM json_each(post.record, '$.turns') turn
      WHERE json_type(post.record, turn.fullkey || '.reply') IS NULL
         OR json_type(post.record, turn.fullkey || '.reply') = 'text'
         OR json_type(post.record, turn.fullkey || '.answer') = 'text'
         OR json_type(post.record, turn.fullkey || '.frozenItems') = 'array')
      OR EXISTS (SELECT 1 FROM json_each(post.record, '$.remoteAsks') ask
        WHERE json_extract(post.record, ask.fullkey || '.reply.kind') = 'answer'))
  ORDER BY sequence DESC`

type Preview = NonNullable<BotGroup['replyPreviews']>[number]
export type RecoveredGroupReplies = { messages: BotGroupMessage[]; complete: boolean }
export type RecoverGroupReplies = (messages: BotGroupMessage[]) => Promise<RecoveredGroupReplies>

export class BotGroupListing {
  private readonly previews = new Map<string, Preview[]>()
  private generation = 0

  missingPreviews(groups: readonly BotGroup[]): string[] {
    return groups.flatMap(({ id }) => (this.previews.has(id) ? [] : [id]))
  }

  invalidate(message: Omit<BotGroupMessage, 'sequence'>): void {
    if (
      !message.threadId &&
      (message.turns.some((turn) => turn.reply || turn.answer || turn.frozenItems) ||
        message.remoteAsks?.some((ask) => ask.reply?.kind === 'answer') ||
        this.previews.get(message.groupId)?.some((reply) => reply.messageId === message.id))
    ) {
      this.delete(message.groupId)
    }
  }

  delete(groupId: string): void {
    this.generation++
    this.previews.delete(groupId)
  }

  async decorate(
    groups: readonly BotGroup[],
    rows: readonly Record<string, unknown>[],
    missing: readonly string[],
    includeReplyPreviews: boolean,
    recover?: RecoverGroupReplies
  ): Promise<BotGroup[]> {
    const generation = this.generation
    const sidebar = new Map<string, Record<string, unknown>>()
    const replies = new Map(missing.map((id) => [id, new Map<string, Preview>()]))
    const messages: BotGroupMessage[] = []
    for (const row of rows) {
      const groupId = String(row.group_id)
      if (typeof row.record === 'string') {
        const parsed = BotGroupMessageSchema.safeParse({
          ...JSON.parse(row.record),
          sequence: Number(row.sequence)
        })
        if (parsed.success) {
          messages.push(parsed.data)
        }
      } else {
        sidebar.set(groupId, row)
      }
    }
    let recovered = messages
    let complete = true
    if (recover && messages.length > 0) {
      try {
        const result = await recover(messages)
        recovered = result.messages
        complete = result.complete
      } catch (error) {
        complete = false
        console.warn('[bot-groups] could not recover stored reply metadata', error)
      }
    }
    for (const message of recovered) {
      const latest = replies.get(message.groupId)
      if (latest) {
        keepLatestReplies(latest, message)
      }
    }
    if (complete && this.generation === generation) {
      for (const [groupId, latest] of replies) {
        this.previews.set(groupId, [...latest.values()])
      }
    }
    return groups.map((group) => {
      const row = sidebar.get(group.id)
      const latest = row?.latest
        ? BotGroupLatestSchema.safeParse(JSON.parse(String(row.latest)))
        : null
      return {
        ...group,
        ...(typeof row?.sidebar_order === 'number' ? { sidebarOrder: row.sidebar_order } : {}),
        ...(latest?.success ? { latest: latest.data } : {}),
        ...(includeReplyPreviews
          ? {
              replyPreviews: this.previews.get(group.id) ?? [
                ...(replies.get(group.id)?.values() ?? [])
              ]
            }
          : {})
      }
    })
  }
}

function keepLatestReplies(previews: Map<string, Preview>, message: BotGroupMessage): void {
  const anchor = { messageId: message.id, sequence: message.sequence }
  for (const turn of message.turns) {
    const frozen =
      turn.frozenItems &&
      turn.reply !== null &&
      (turn.replyAt === undefined || turn.replyMessageId === undefined)
        ? botGroupCompletedReply(turn.frozenItems)
        : null
    const reply = botGroupTurnReplyText(turn.reply ?? frozen?.text, turn.answer)
    keepPreview(previews, {
      ...anchor,
      text: reply ?? '',
      at: turn.replyAt ?? frozen?.completedAt ?? null,
      botId: turn.botId,
      operationId: turn.operationId,
      replyMessageId: turn.replyMessageId ?? frozen?.messageId
    })
  }
  for (const ask of message.remoteAsks ?? []) {
    if (ask.reply?.kind === 'answer') {
      keepPreview(previews, {
        ...anchor,
        source: 'mail',
        environmentId: ask.environmentId,
        botId: ask.botId,
        requestId: ask.requestId,
        replyMessageId: ask.reply.messageId,
        receivedSequence: ask.reply.receivedSequence,
        text: botGroupTurnReplyText(ask.reply.text, undefined) ?? '',
        at: ask.reply.receivedAt ?? null
      })
    }
  }
}

function keepPreview(previews: Map<string, Preview>, preview: Preview): void {
  const text = preview.text.replace(/\s+/g, ' ').trim().slice(0, 500)
  const key = JSON.stringify([
    preview.source === 'mail' ? preview.environmentId : null,
    preview.botId
  ])
  const previous = previews.get(key)
  const laterMail =
    preview.source === 'mail' &&
    previous?.source === 'mail' &&
    preview.at !== null &&
    preview.at === previous.at &&
    preview.receivedSequence !== undefined &&
    previous.receivedSequence !== undefined &&
    preview.receivedSequence > previous.receivedSequence
  if (text && (!previous || (previous.at ?? -Infinity) < (preview.at ?? -Infinity) || laterMail)) {
    previews.set(key, { ...preview, text })
  }
}
