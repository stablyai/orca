import { createHash } from 'node:crypto'
import { z } from 'zod'
export const binding = z.object({
  account: z.string(),
  bot: z.string(),
  profile: z.string(),
  app: z.string(),
  owner: z.string().nullable(),
  chat: z.string().nullable(),
  pairedAt: z.number().int().nullable()
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
