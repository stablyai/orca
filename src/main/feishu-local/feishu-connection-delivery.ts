import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { deliverFeishuMessages } from './feishu-deliveries'
import { acknowledgeFeishuMessage } from './feishu-dm-replies'
import { startFeishuDm } from './feishu-dm-delivery'
import { drainFeishuDmOutbox } from './feishu-dm-outbox'
import { drainFeishuOutbox } from './feishu-outbox'
import type { Binding } from './feishu-binding'
import type { FeishuStore } from './feishu-store-ops'
import type { FeishuTransport } from './feishu-transport'
import type { FeishuMessageIngress } from './feishu-message-ingress'
import type { FeishuInteractions } from './feishu-interactions'
import type { Bot } from '../../shared/bot-types'

type Delivery = {
  runtime: OrcaRuntimeService
  inbox: FeishuStore
  binding: Binding
  signal: AbortSignal
  bot: () => Bot | false | undefined
  checkProfile: () => Promise<void>
  retryWork: () => void
  changed: () => void
  repeat: () => void
  ingress: FeishuMessageIngress
  interactions: FeishuInteractions
}
export async function drainFeishuConnection(c: Delivery, api: FeishuTransport): Promise<void> {
  const b = c.binding
  if (b.profile !== null) {
    await drainCli(c, api)
    return
  }
  let row = await c.inbox.next(b.account)
  for (let count = 0; row && !c.signal.aborted && count < 32; count++) {
    const bot = c.bot()
    if (!bot) {
      return
    }
    const initial = await startFeishuDm(c.runtime, api, c.inbox, b, row, bot.agent, c.signal, () =>
      Boolean(c.bot())
    )
    if (!initial || c.signal.aborted) {
      return
    }
    if (initial.outcome === 'refused' && initial.reason === 'delivery_backlog_full') {
      c.retryWork()
      break
    }
    if (initial.outcome === 'accepted') {
      await acknowledgeFeishuMessage(api, c.inbox, b, row.mid, c.signal, () => Boolean(c.bot()))
    } else {
      await c.inbox.review(b.account, row.mid)
      c.changed()
    }
    await c.inbox.admitted(b.account, row.mid)
    row = await c.inbox.next(b.account)
  }
  if (row && !c.signal.aborted) {
    c.repeat()
  }
  const journal = getStructuredAgentSessionHost()?.deps.store.connectorReplies()
  if (!journal) {
    await c.runtime.ensureStructuredAgentSessionHost()
    c.retryWork()
    return
  }
  await drainFeishuDmOutbox(
    api,
    journal,
    c.inbox,
    c.binding,
    c.signal,
    () => !c.signal.aborted && Boolean(c.bot()),
    () => c.changed()
  )
}
async function drainCli(c: Delivery, api: FeishuTransport): Promise<void> {
  const b = c.binding
  const seam = c.runtime.getExternalConversationSeam()
  const bot = c.bot()
  if (!b.owner || !b.chat || !seam || !bot) {
    return
  }
  await deliverFeishuMessages(
    api,
    c.runtime,
    c.inbox,
    b,
    bot,
    c.signal,
    () => Boolean(c.bot()),
    () => c.checkProfile(),
    () => c.retryWork(),
    () => c.changed()
  )
  const displayName = await c.ingress.displayName(b.app)
  // Answer cards before draining their resulting user messages on the next pass.
  try {
    await c.interactions.drain(displayName)
  } finally {
    await sendOwed(c, displayName)
  }
}
async function sendOwed(c: Delivery, displayName: string): Promise<void> {
  if (!c.binding.chat || !c.bot()) {
    return
  }
  const journal = getStructuredAgentSessionHost()?.deps.store.connectorReplies()
  if (!journal) {
    await c.runtime.ensureStructuredAgentSessionHost()
    c.retryWork()
    return
  }
  await drainFeishuOutbox(
    journal,
    c.inbox,
    c.binding,
    c.signal,
    () => !c.signal.aborted && Boolean(c.bot()),
    () => c.checkProfile(),
    () => c.changed(),
    displayName,
    c.interactions.cards,
    c.runtime
  )
}
