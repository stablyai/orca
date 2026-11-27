// The phone's reads and actions on a bot chat's Slack thread: its link from the bot home's folder,
// and the host's switch, post and status calls.
import * as z from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../transport/rpc/rpc-operation-result-reader'
import { salvagingArray } from '../../../../../src/shared/validation/zod-salvage'
import {
  SLACK_MIRROR_BLOCKS,
  SLACK_MIRROR_POST_STATES
} from '../../../../../src/shared/connectors/external-conversation-link'
import { SlackMirrorStatus } from '../../../../../src/shared/connectors/connector-slack-mirror-contract'

const mirrorLinkSchema = z.looseObject({
  source: z.literal('slack'),
  externalId: z.string(),
  sessionId: z.string(),
  bot: z.object({ botId: z.string(), kind: z.enum(['bot', 'bot-chat']) }),
  place: z.string().optional(),
  opener: z
    .object({
      role: z.enum(['owner', 'member']),
      name: z.string().optional(),
      dm: z.literal(true).optional()
    })
    .optional()
    .catch(undefined),
  mirror: z.boolean().optional().catch(undefined),
  mirrorBlocked: z.enum(SLACK_MIRROR_BLOCKS).optional().catch(undefined),
  mirrorChosen: z.literal(true).optional().catch(undefined),
  mirrorExternal: z.boolean().optional().catch(undefined),
  mirrorPosts: z
    .record(
      z.string(),
      z.object({
        state: z.enum(SLACK_MIRROR_POST_STATES),
        at: z.number(),
        error: z.string().optional()
      })
    )
    .optional()
    .catch(undefined)
})
export type MobileSlackMirrorLink = z.infer<typeof mirrorLinkSchema>

/** Every bot home's Slack thread links, by folder id; a link this build can't read is dropped. */
export const slackMirrorLinksRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'folderWorkspace.slack-mirror-links-or-skip',
    method: 'folderWorkspace.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'slack-mirror-links',
      z
        .looseObject({
          folderWorkspaces: salvagingArray(
            z.looseObject({
              id: z.string(),
              externalConversations: salvagingArray(mirrorLinkSchema).optional()
            })
          )
        })
        .transform(({ folderWorkspaces }) =>
          Object.fromEntries(
            folderWorkspaces.map((folder) => [folder.id, folder.externalConversations ?? []])
          )
        )
    )
  })
)

const okResult = z.looseObject({ ok: z.boolean() })

export const slackMirrorSet = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'connector.slack-mirror.set',
    method: 'connector.slackMirror.set',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('slack-mirror-set', okResult)
  })
)

export const slackMirrorPost = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'connector.slack-mirror.post',
    method: 'connector.slackMirror.post',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('slack-mirror-post', okResult)
  })
)

export const slackMirrorStatusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'connector.slack-mirror.status',
    method: 'connector.slackMirror.status',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'slack-mirror-status',
      z.looseObject({ status: SlackMirrorStatus.nullable() })
    )
  })
)
