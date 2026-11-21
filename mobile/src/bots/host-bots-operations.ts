import * as z from 'zod'
import { AGENT_CHAT_PERMISSION_MODES } from '../../../src/shared/agent-launch/permissions/agent-chat-permission-mode'
import { BotMemberSchema, BotNotificationsSchema, BotSchema } from '../../../src/shared/bot-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../../src/shared/worktree/lineage-types'
import { salvagedOptional, salvagingArray } from '../../../src/shared/validation/zod-salvage'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import { normalizeBotSidebarView } from '../../../src/shared/bots/bot-sidebar-view'
import { CONNECTOR_SOURCES } from '../../../src/shared/connectors/external-conversation-link'
import { CONNECTOR_CLOUD_STATUSES } from '../../../src/shared/bots/connector-cloud-status'

// The phone's one bot shape, for the list, links and sheet. `agent` and `permissionMode` follow
// public agent lists that grow with each release, so a host's new one never drops a bot.
export const phoneBotSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  folderWorkspaceId: z.string().min(1),
  avatar: z.string().nullable(),
  avatarColor: BotSchema.shape.avatarColor,
  paused: z.boolean(),
  agent: z.string(),
  permissionMode: salvagedOptional('permissionMode', z.enum(AGENT_CHAT_PERMISSION_MODES)),
  launch: BotSchema.shape.launch,
  notifications: BotNotificationsSchema,
  members: salvagingArray(BotMemberSchema),
  // Only whether each is set: an automation's events need their connector.
  slack: BotSchema.shape.slack,
  linear: BotSchema.shape.linear,
  linearWorkspaces: BotSchema.shape.linearWorkspaces,
  github: BotSchema.shape.github,
  google: BotSchema.shape.google,
  lookAround: BotSchema.shape.lookAround,
  tidyUp: BotSchema.shape.tidyUp,
  // When its items go stale, so Needs you counts and Stale group as the desktop's do.
  itemsStale: BotSchema.shape.itemsStale,
  // So a wait's row in its chats says it was cancelled.
  cancelledWaits: BotSchema.shape.cancelledWaits,
  // The Home Chat, where Up next's Start puts its request.
  chatSessionId: BotSchema.shape.chatSessionId,
  // Its offer cards' answers and the bots made from them, so a card reads how it ended.
  offerAnswers: BotSchema.shape.offerAnswers,
  acceptedOffers: BotSchema.shape.acceptedOffers
})

export type PhoneBot = z.output<typeof phoneBotSchema>

/** What the host list draws of a bot. */
export type ListedBot = Pick<
  PhoneBot,
  'id' | 'name' | 'folderWorkspaceId' | 'avatar' | 'paused' | 'chatSessionId'
>

/** The bot's saved state as a phone edit returns it. */
export const phoneBotReply = z.looseObject({ bot: phoneBotSchema })

// A wait as a bot row names it; a malformed one is dropped, not the bot's others.
const botWaitsSchema = z.record(
  z.string(),
  salvagingArray(z.looseObject({ label: z.string(), by: z.number().optional() }))
)

const botNeedsYouSchema = z.record(z.string(), z.number().int().nonnegative())

export const botsListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.list-or-skip',
    method: 'bots.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'bots',
      z
        .looseObject({
          bots: salvagingArray(phoneBotSchema),
          botsEnabled: z.boolean(),
          hideBotCreatedWorkspaces: z.boolean(),
          // The host's Bot options; a host from before them lists in its saved order.
          botSidebarView: z.unknown().optional(),
          // Each bot's waits still waiting, for its row's line; older hosts send none.
          waits: z.unknown().optional(),
          // Each bot's Needs you items that aren't stale; hosts before items on phones send none.
          needsYou: z.unknown().optional(),
          // When those counts next change (an item goes stale or a snoozed one comes back).
          needsYouStaleInMs: z.number().optional().catch(undefined),
          // The host's Orca Cloud link; absent from an older host, and a newer value reads as absent.
          connectorStatus: z.enum(CONNECTOR_CLOUD_STATUSES).optional().catch(undefined),
          // Whether its Orca Cloud answers an event in its own thread; older hosts don't say.
          threadReplies: z.boolean().optional().catch(undefined)
        })
        // Off, the host's own sidebar lists its bot homes as ordinary folders, so the phone does too.
        .transform((listing) => ({
          enabled: listing.botsEnabled,
          bots: listing.botsEnabled ? listing.bots : [],
          hideBotCreated: listing.hideBotCreatedWorkspaces,
          view: normalizeBotSidebarView(listing.botSidebarView),
          waits: botWaitsSchema.catch({}).parse(listing.waits ?? {}),
          needsYou: botNeedsYouSchema.catch({}).parse(listing.needsYou ?? {}),
          connectorStatus: listing.connectorStatus,
          threadReplies: listing.threadReplies === true,
          ...(listing.needsYouStaleInMs !== undefined
            ? { needsYouChangeInMs: listing.needsYouStaleInMs }
            : {})
        }))
    )
  })
)

function hasStrings(keys: readonly string[]): (value: unknown) => boolean {
  const shape = z.looseObject(Object.fromEntries(keys.map((key) => [key, z.string()])))
  return (value) => shape.safeParse(value).success
}

// The fields the shared resolver reads; it validates the edges itself.
const workspaceLineageSchema = z.custom<WorkspaceLineage>(
  hasStrings(['childWorkspaceKey', 'parentWorkspaceKey', 'origin'])
)
const worktreeLineageSchema = z.custom<WorktreeLineage>(
  hasStrings(['worktreeId', 'worktreeInstanceId', 'parentWorktreeId', 'parentWorktreeInstanceId'])
)

function salvagingRecord<T>(entry: z.ZodType<T>) {
  return z.record(z.string(), z.unknown()).transform((raw) => {
    const kept: Record<string, T> = {}
    for (const [key, value] of Object.entries(raw)) {
      const parsed = entry.safeParse(value)
      if (parsed.success) {
        kept[key] = parsed.data
      }
    }
    return kept
  })
}

export const workspaceLineageRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.lineage-or-skip',
    method: 'worktree.lineageList',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'lineage',
      z.looseObject({
        lineage: salvagingRecord(worktreeLineageSchema),
        workspaceLineage: salvagingRecord(workspaceLineageSchema)
      })
    )
  })
)

export const botAvatarRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.avatar-or-skip',
    method: 'bots.avatar.read',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-avatar', z.looseObject({ png: z.string().nullable() }))
  })
)

/** The host-wide Up next count route. */
export const botUpNextUnseenRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.upNext.unseen-or-skip',
    method: 'bots.upNext.unseen',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'bot-up-next-unseen',
      z.looseObject({ unseen: z.record(z.string(), z.number().nonnegative()) })
    )
  })
)

// A chat the line can't read is dropped, not the bot's others.
const botOwnChatSchema = z.looseObject({ paneKey: z.string(), title: z.string() })

/** Each bot's own side chats, for its row's line; an older host skips it. */
export const botOwnChatsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.chats.own-or-skip',
    method: 'bots.chats.own',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'bot-own-chats',
      z.looseObject({ chats: z.record(z.string(), salvagingArray(botOwnChatSchema)) })
    )
  })
)

// What a bot row's line reads of a thread's link; a link it can't read is dropped, not its folder.
const botRowLinkSchema = z.looseObject({
  source: z.enum(CONNECTOR_SOURCES),
  externalId: z.string().optional(),
  bot: z.object({ botId: z.string(), kind: z.enum(['bot', 'bot-chat']) }).optional(),
  sessionId: z.string(),
  paneKey: z.string(),
  title: z.string().optional(),
  place: z.string().optional(),
  lastTurn: z.enum(['conversation', 'orca']).optional()
})

/** Each folder's thread links, for its bot row's line: which panes are its threads, and where. */
export const botHomeLinksRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'folderWorkspace.bot-links-or-skip',
    method: 'folderWorkspace.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'bot-home-links',
      z
        .looseObject({
          folderWorkspaces: salvagingArray(
            z.looseObject({
              id: z.string(),
              externalConversations: salvagingArray(botRowLinkSchema).optional()
            })
          )
        })
        .transform(({ folderWorkspaces }) =>
          Object.fromEntries(
            folderWorkspaces.flatMap((folder) =>
              folder.externalConversations?.length
                ? [[folder.id, folder.externalConversations] as const]
                : []
            )
          )
        )
    )
  })
)
