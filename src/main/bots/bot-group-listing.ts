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
    AND EXISTS (SELECT 1 FROM json_each(post.record, '$.turns') turn
      WHERE json_type(turn.value, '$.reply') = 'text'
         OR json_type(turn.value, '$.answer') = 'text'
         OR json_type(turn.value, '$.frozenItems') = 'array')
  ORDER BY sequence DESC`

type Preview = NonNullable<BotGroup['replyPreviews']>[number]

export class BotGroupListing {
  private readonly previews = new Map<string, Preview[]>()

  missingPreviews(groups: readonly BotGroup[]): string[] {
    return groups.flatMap(({ id }) => (this.previews.has(id) ? [] : [id]))
  }

  invalidate(message: Omit<BotGroupMessage, 'sequence'>): void {
    if (
      !message.threadId &&
      (message.turns.some((turn) => turn.reply || turn.answer || turn.frozenItems) ||
        this.previews.get(message.groupId)?.some((reply) => reply.messageId === message.id))
    ) {
      this.delete(message.groupId)
    }
  }

  delete(groupId: string): void {
    this.previews.delete(groupId)
  }

  decorate(
    groups: readonly BotGroup[],
    rows: readonly Record<string, unknown>[],
    missing: readonly string[],
    includeReplyPreviews: boolean
  ): BotGroup[] {
    const sidebar = new Map<string, Record<string, unknown>>()
    const replies = new Map(missing.map((id) => [id, new Map<string, Preview>()]))
    for (const row of rows) {
      const groupId = String(row.group_id)
      if (typeof row.record === 'string') {
        const latest = replies.get(groupId)
        const parsed = BotGroupMessageSchema.safeParse({
          ...JSON.parse(row.record),
          sequence: Number(row.sequence)
        })
        if (latest && parsed.success) {
          keepLatestReplies(latest, parsed.data)
        }
      } else {
        sidebar.set(groupId, row)
      }
    }
    for (const [groupId, latest] of replies) {
      this.previews.set(groupId, [...latest.values()])
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
        ...(includeReplyPreviews ? { replyPreviews: this.previews.get(group.id) ?? [] } : {})
      }
    })
  }
}

function keepLatestReplies(previews: Map<string, Preview>, message: BotGroupMessage): void {
  for (const turn of message.turns) {
    const frozen =
      turn.reply === undefined && turn.frozenItems ? botGroupCompletedReply(turn.frozenItems) : null
    const reply = botGroupTurnReplyText(turn.reply ?? frozen?.text, turn.answer)
    const text = reply?.replace(/\s+/g, ' ').trim().slice(0, 500)
    const at = turn.replyAt ?? frozen?.completedAt ?? message.createdAt
    const previous = previews.get(turn.botId)
    if (text && (!previous || previous.at < at)) {
      previews.set(turn.botId, {
        text,
        at,
        botId: turn.botId,
        messageId: message.id,
        sequence: message.sequence,
        operationId: turn.operationId,
        replyMessageId: turn.replyMessageId ?? frozen?.messageId
      })
    }
  }
}
