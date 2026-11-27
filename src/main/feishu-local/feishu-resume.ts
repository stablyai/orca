import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { FeishuStore } from './feishu-store-ops'
import type { Binding } from './feishu-binding'
import { chatAwaitsResume } from '../external-conversations/external-conversation-resume'
import { findLink } from '../external-conversations/external-conversation-links'
import { runtimeConversationHost } from '../external-conversations/external-conversation-runtime-host'
export async function offerFeishuResume(
  runtime: OrcaRuntimeService,
  store: FeishuStore,
  b: Binding,
  external: string,
  turn: number | null
): Promise<void> {
  const key = { source: 'feishu-local' as const, externalId: external }
  const linked = findLink(runtime.requireStore(), key)
  const route = await store.laneRoute(b.account, external)
  if (!linked || !route) {
    return
  }
  const chat = await runtimeConversationHost(runtime).chat?.ensure()
  if (!(await chatAwaitsResume(chat ?? null, linked.link.sessionId, linked))) {
    return
  }
  const cut = chat && (await chat.conversation(linked.link.sessionId)).journal
  const identity = turn ?? (await cut?.reads.orcaStopCut())?.turnItemId ?? route.original
  await store.putCard(
    b.account,
    `resume:${external}:${identity}`,
    external,
    route.original,
    route.chat,
    {
      kind: 'resume',
      inline: true,
      text: '本轮处理已中断，可以沿原会话继续。',
      options: [{ id: 'resume', label: '继续处理', answer: '请继续刚才中断的任务。' }]
    }
  )
}
