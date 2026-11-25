import { z } from 'zod'
import { feishuCommand, type FeishuMessage } from './feishu-cli'
import type { Binding } from './feishu-binding'
import type { FeishuStore } from './feishu-store-ops'
import { threadKey } from './feishu-route-key'
import { feishuThreadContext } from './feishu-thread-history'

export class FeishuMessageIngress {
  private botOpenId?: string
  private botName?: string
  constructor(
    private readonly store: FeishuStore,
    private readonly signal: AbortSignal
  ) {}
  async displayName(app: string): Promise<string> {
    if (!this.botName) {
      const response = await feishuCommand(
        ['--profile', app, 'api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot'],
        this.signal
      )
      const { data } = z
        .object({
          ok: z.literal(true),
          identity: z.literal('bot'),
          data: z.object({ open_id: z.string(), app_name: z.string().trim().min(1) })
        })
        .parse(response)
      this.botOpenId = data.open_id
      this.botName = data.app_name
    }
    return this.botName
  }
  async receive(b: Binding, m: FeishuMessage): Promise<void> {
    if (b.owner !== m.sender_id || m.sender_type === 'bot') {
      return
    }
    if (m.chat_type === 'p2p' && b.chat !== m.chat_id) {
      return
    }
    const parent = m.root_id || m.reply_to
    const known = parent ? await this.store.messageRoute(b.account, parent) : null
    if (known && known.chat !== m.chat_id) {
      return
    }
    if (m.chat_type === 'group' && !known) {
      await this.displayName(b.app)
      if (!m.mentions?.some((mention) => mention.id === this.botOpenId)) {
        return
      }
    }
    const history =
      !known && m.message_type === 'text' ? await feishuThreadContext(b, m, this.signal) : ''
    const root = known?.root ?? parent ?? m.message_id
    const external = known?.external ?? threadKey(b, m.chat_id, root).externalId
    await this.store.putRoute(b.account, m.message_id, {
      external,
      chat: m.chat_id,
      root,
      original: m.message_id,
      group: m.chat_type === 'group'
    })
    await this.store.putRoute(b.account, root, {
      external,
      chat: m.chat_id,
      root,
      original: root,
      group: m.chat_type === 'group'
    })
    await this.store.accept(b, {
      ...m,
      content:
        history +
        (this.botOpenId
          ? (m.mentions ?? [])
              .filter((mention) => mention.id === this.botOpenId)
              .reduce((text, mention) => text.replaceAll(mention.key, ''), m.content)
              .trim() || m.content
          : m.content)
    })
  }
}
