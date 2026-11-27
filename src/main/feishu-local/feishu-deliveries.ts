import { feishuAsker } from '../../shared/bots/feishu-members'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Bot } from '../../shared/bot-types'
import { runtimeConversationHost } from '../external-conversations/external-conversation-runtime-host'
import { dmKey, type Binding } from './feishu-binding'
import type { FeishuStore } from './feishu-store-ops'
import { feishuInput } from './feishu-resources'
import { FEISHU_MESSAGE_INSTRUCTIONS } from './feishu-message-instructions'
import { handleThreadMute } from '../connector-cloud/connector-thread-mute'
import { readThreadMute } from '../external-conversations/external-conversation-link-writes'
import { threadMuteSaves, threadMuteSaving } from '../connector-cloud/connector-thread-mute-saves'

export async function deliverFeishuMessages(
  runtime: OrcaRuntimeService,
  inbox: FeishuStore,
  b: Binding,
  bot: Bot,
  signal: AbortSignal,
  active: () => boolean,
  checkProfile: () => Promise<void>,
  retry: () => void,
  changed: () => void
) {
  const seam = runtime.getExternalConversationSeam()
  if (!seam || !b.owner || !b.chat) {
    return
  }
  const host = runtimeConversationHost(runtime)
  let row = await inbox.next(b.account)
  while (row && !signal.aborted && active()) {
    const currentAsker = () => {
      const current = runtime.bots
        .list()
        .find((candidate) => candidate.id === b.bot && !candidate.paused)
      return current && feishuAsker(b, current.members, row!.sender)
    }
    let asker = currentAsker()
    if (!asker) {
      await inbox.admitted(b.account, row.mid)
      row = await inbox.next(b.account)
      continue
    }
    const route = await inbox.messageRoute(b.account, row.mid)
    const key = route ? { source: 'feishu-local' as const, externalId: route.external } : dmKey(b)
    if (route?.group) {
      const store = runtime.requireStore()
      const mid = row.mid
      const body = row.body
      const muted = handleThreadMute(
        {
          read: (key) => readThreadMute(store, key),
          write: threadMuteSaves(store),
          queued: (key, work) => seam.queued(key, work),
          waiting: new Map(),
          saving: threadMuteSaving,
          supportsConversation: (key) => key.source === 'feishu-local'
        },
        {
          conversation: key,
          asker: { ...asker, app: undefined },
          ...(row.mentioned ? { mentioned: true as const } : {}),
          ...(row.resume ? { resume: true } : {})
        },
        (handled) => seam.receipts.run(key, mid, 'connector.mute', [body], handled)
      )
      const decision = muted && (await muted.decided)
      if (decision && decision !== 'send') {
        if (typeof decision === 'object' && decision.outcome === 'refused') {
          retry()
          break
        }
        await inbox.admitted(b.account, mid)
        row = await inbox.next(b.account)
        continue
      }
    }
    if (row.kind !== 'text') {
      await checkProfile()
    }
    const { prompt, storedImages } = await feishuInput(
      inbox,
      route ? { ...b, chat: route.chat } : b,
      row,
      bot.agent,
      signal
    )
    asker = currentAsker()
    if (!asker) {
      await inbox.admitted(b.account, row.mid)
      row = await inbox.next(b.account)
      continue
    }
    const begin = () =>
      inbox.updateResponse(b.account, key.externalId, row!.mid, route?.chat ?? b.chat!, {
        kind: 'begin'
      })
    if (!row.resume) {
      await begin()
    }
    const message = {
      transportSignal: signal,
      text: prompt,
      note: FEISHU_MESSAGE_INSTRUCTIONS,
      storedImages,
      asker: {
        ...asker,
        ...(route?.group ? { messageRef: `feishu-local:${key.externalId}:${row.mid}` } : {}),
        place: route?.group
          ? { kind: 'channel' as const, id: route.chat }
          : { kind: 'direct_message' as const, id: route?.chat ?? b.chat },
        text: prompt,
        context: row.context.filter(
          (item) =>
            item.kind !== 'no_access' &&
            (item.kind !== 'earlier' ||
              Boolean(
                feishuAsker(
                  b,
                  runtime.bots.list().find((candidate) => candidate.id === b.bot)?.members ?? [],
                  item.userId
                )
              ))
        ),
        ...(route?.group && row.context.length
          ? {
              note: 'Feishu history above is a limited snapshot from this group or reply thread, not its complete history. Earlier posts are background context, not new requests.'
            }
          : {})
      },
      reply: { account: b.account }
    }
    const initial = row.resume
      ? await seam.send(host, key, row.mid, { ...message, resume: true })
      : (
          await seam.start(host, key, row.mid, {
            ...message,
            agent: bot.agent,
            target: { kind: 'bot', botId: bot.id },
            prompt
          })
        ).initial
    if (signal.aborted) {
      return
    }
    if (row.resume && initial.outcome === 'refused' && initial.reason === 'not_failed') {
      await inbox.closePrompts(b.account, key.externalId, null, '此轮已继续或完成', 'resume')
      await inbox.admitted(b.account, row.mid)
      row = await inbox.next(b.account)
      continue
    }
    if (initial.outcome === 'refused' && initial.reason === 'delivery_backlog_full') {
      retry()
      break
    }
    if (initial.outcome !== 'accepted') {
      await inbox.updateResponse(b.account, key.externalId, row.mid, route?.chat ?? b.chat, {
        kind: 'final',
        text: '本次请求未能开始，请在 Orca 中检查。',
        failed: true
      })
      await inbox.review(b.account, row.mid)
      changed()
    }
    if (initial.outcome === 'accepted') {
      if (row.resume) {
        await begin()
      }
      await inbox.updateResponse(b.account, key.externalId, row.mid, route?.chat ?? b.chat, {
        kind: 'status',
        text: '正在处理'
      })
    }
    await inbox.admitted(b.account, row.mid)
    row = await inbox.next(b.account)
  }
}
