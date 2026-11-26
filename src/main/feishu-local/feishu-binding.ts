import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FeishuGroupPolicy } from '../../shared/bots/feishu-local'
import type { FeishuGroupRoute } from './feishu-message'
export const binding = z.object({
  account: z.string(),
  bot: z.string(),
  profile: z.string().nullable(),
  app: z.string(),
  owner: z.string().nullable(),
  chat: z.string().nullable(),
  pairedAt: z.number().int().nullable(),
  group: FeishuGroupPolicy.optional()
})
export type Binding = z.infer<typeof binding>
export function dmKey(b: Binding) {
  return {
    source: 'feishu-local' as const,
    externalId: createHash('sha256')
      .update(JSON.stringify([b.account, b.bot, b.app, b.owner, b.chat]))
      .digest('hex')
  }
}

export function groupKey(b: Binding, group: FeishuGroupRoute) {
  // The topic key stays stable while each delivery keeps its own reply target.
  return {
    source: 'feishu-group' as const,
    externalId: createHash('sha256')
      .update(JSON.stringify([b.account, b.bot, b.app, group.tenant, group.chatId, group.rootId]))
      .digest('hex')
  }
}
