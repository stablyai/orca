// 4a send and queue rows, plus R3's retained-history admission: a small live queue over growing released history.
import { operationId } from './native-chat-4a-arm'
import { rpc, markerSeenAt, watchMarkers } from './native-chat-4a-probes'
import {
  addRow,
  measured,
  page,
  sampled,
  tagFor,
  type RunContext
} from './native-chat-4a-run-context'
import {
  history,
  mutate,
  openChatTab,
  send,
  waitForControls,
  waitForIdle,
  waitForWorking
} from './native-chat-4a-session'
import { holdPrompt, replyPrompt } from './native-chat-4a-workloads'
import providerText from './native-chat-4a-provider-text.cjs'

/** Type into the composer, then click Send inside the page so the start mark is the click itself. */
async function clickSend(ctx: RunContext, text: string): Promise<number> {
  const composer = page(ctx)
    .locator('[data-native-chat-root="true"]:visible [role="textbox"]')
    .first()
  await composer.fill(text)
  return page(ctx).evaluate(() => {
    const root = [...document.querySelectorAll('[data-native-chat-root="true"]')].find(
      (candidate) => candidate.checkVisibility()
    )
    const button = [...(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (candidate) =>
        candidate.getAttribute('aria-label') === 'Send' || candidate.textContent?.trim() === 'Send'
    )
    if (!button) {
      throw new Error('Send button not found')
    }
    const startedAt = performance.now()
    button.click()
    return startedAt
  })
}

export const sentText = (tag: string, padding = 0): string =>
  `${providerText.formatDirective({ op: 'reply', tag }, padding)} 4A-SENT-${tag}`

export async function holdActive(ctx: RunContext, sessionId: string, ms: number): Promise<string> {
  const tag = tagFor('hold')
  await send(page(ctx), ctx.arm, sessionId, holdPrompt(tag, ms))
  await waitForWorking(page(ctx), true)
  return tag
}

export async function queued(ctx: RunContext, sessionId: string) {
  return (await history(page(ctx), sessionId, 'tail', 1)).page.queuedMessages ?? []
}

export async function sendAndQueueRows(ctx: RunContext): Promise<void> {
  const { workspace, fillerSessionIds, largeSessionId } = ctx.manifest
  const small = fillerSessionIds[0]!
  const n = ctx.workload.samples
  await openChatTab(page(ctx), workspace.worktreeIds[1], small)
  await waitForControls(page(ctx))

  const idle = addRow(ctx, {
    family: 'send',
    operation: 'idle direct send',
    variant: 'small chat, click',
    context: { chats: fillerSessionIds.length + 1 }
  })
  await sampled(ctx, idle, n, () =>
    measured(ctx, async () => {
      const tag = tagFor('idle')
      await watchMarkers(page(ctx), [`4A-SENT-${tag}`, `4A-TAIL-${tag}`])
      const clickedAt = await clickSend(ctx, sentText(tag))
      const sentAt = await markerSeenAt(page(ctx), `4A-SENT-${tag}`)
      const handover = await waitForWorking(page(ctx), true).catch(() => Number.NaN)
      const replyAt = await markerSeenAt(page(ctx), `4A-TAIL-${tag}`)
      await waitForIdle(page(ctx), small)
      return {
        e2eMs: sentAt - clickedAt,
        extra: { handoverMs: handover - clickedAt, replyVisibleMs: replyAt - clickedAt }
      }
    })
  )

  const duplicate = addRow(ctx, {
    family: 'send',
    operation: 'duplicate retry',
    variant: 'same operation id',
    context: {}
  })
  await sampled(ctx, duplicate, n, async () => {
    const tag = tagFor('dup')
    const params = ctx.arm.protocol.structuredAgentSessionMessageSendMutation({
      sessionId: small,
      clientOperationId: operationId(ctx.arm),
      expectedRuntimeFence: (await history(page(ctx), small, 'tail', 1)).page.fence ?? 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: replyPrompt(tag) }] },
      delivery: 'queue-if-active'
    })
    const first = await rpc(page(ctx), 'agentSession.send', params)
    const sample = await measured(ctx, async () => ({
      hostMs: (await rpc(page(ctx), 'agentSession.send', params)).hostMs
    }))
    await waitForIdle(page(ctx), small)
    return { ...sample, extra: { firstHostMs: first.hostMs } }
  })

  await openChatTab(page(ctx), workspace.worktreeIds[0], largeSessionId)
  await waitForControls(page(ctx))
  for (const populated of [0, 5]) {
    const active = addRow(ctx, {
      family: 'send',
      operation: 'send while active',
      variant: `large chat, ${populated} already queued`,
      context: {
        largeItems: ctx.manifest.largeItems,
        queueLength: populated,
        queuedBodyBytes: populated * 4096
      }
    })
    await sampled(ctx, active, n, async () => {
      await holdActive(ctx, largeSessionId, 60_000)
      for (let index = 0; index < populated; index += 1) {
        await send(page(ctx), ctx.arm, largeSessionId, sentText(tagFor('fill'), 4096))
      }
      const tag = tagFor('active')
      await watchMarkers(page(ctx), [`4A-SENT-${tag}`])
      const sample = await measured(ctx, async () => {
        const answer = await send(page(ctx), ctx.arm, largeSessionId, sentText(tag))
        const shownAt = await markerSeenAt(page(ctx), `4A-SENT-${tag}`)
        return { hostMs: answer.hostMs, e2eMs: shownAt - answer.startedAt }
      })
      await mutate(page(ctx), ctx.arm, 'agentSession.cancel', largeSessionId, {})
      await drainQueue(ctx, largeSessionId)
      return sample
    })
  }

  for (const editHold of [false, true]) {
    const claim = addRow(ctx, {
      family: 'send',
      operation: 'queue claim',
      variant: editHold ? 'after edit hold release' : 'no edit hold',
      context: { queueLength: 1 }
    })
    await sampled(ctx, claim, n, async () => {
      const hold = await holdActive(ctx, largeSessionId, 1_500)
      const tag = tagFor('claim')
      await send(page(ctx), ctx.arm, largeSessionId, sentText(tag))
      const [card] = await queued(ctx, largeSessionId)
      const editId = tagFor('edit')
      if (editHold && card) {
        const expectedBodyFingerprint = ctx.arm.protocol.agentSessionSendBodyFingerprint(
          largeSessionId,
          card.body
        )
        await rpc(page(ctx), 'agentSession.queuedMessageEditHold', {
          sessionId: largeSessionId,
          messageId: card.messageId,
          editId,
          action: 'acquire',
          expectedBodyFingerprint
        })
      }
      await watchMarkers(page(ctx), [`4A-TAIL-${hold}`, `4A-TAIL-${tag}`])
      // With a hold, the claim can start only at release; without one, at the active turn's reply.
      let freedAt = await markerSeenAt(page(ctx), `4A-TAIL-${hold}`)
      if (editHold && card) {
        const release = {
          sessionId: largeSessionId,
          messageId: card.messageId,
          editId,
          action: 'release'
        }
        freedAt = (await rpc(page(ctx), 'agentSession.queuedMessageEditHold', release)).startedAt
      }
      const repliedAt = await markerSeenAt(page(ctx), `4A-TAIL-${tag}`)
      await waitForIdle(page(ctx), largeSessionId)
      return { e2eMs: repliedAt - freedAt }
    })
  }

  const edit = addRow(ctx, {
    family: 'send',
    operation: 'queued edit and move',
    variant: '3 queued',
    context: { queueLength: 3 }
  })
  await sampled(ctx, edit, n, async () => {
    await holdActive(ctx, largeSessionId, 60_000)
    for (let index = 0; index < 3; index += 1) {
      await send(page(ctx), ctx.arm, largeSessionId, sentText(tagFor('q')))
    }
    const cards = await queued(ctx, largeSessionId)
    const target = cards.at(-1)!
    const tag = tagFor('edited')
    await watchMarkers(page(ctx), [`4A-SENT-${tag}`])
    const sample = await measured(ctx, async () => {
      const update = await mutate(
        page(ctx),
        ctx.arm,
        'agentSession.queuedMessageUpdate',
        largeSessionId,
        {
          messageId: target.messageId,
          expectedBodyFingerprint: ctx.arm.protocol.agentSessionSendBodyFingerprint(
            largeSessionId,
            target.body
          ),
          text: sentText(tag)
        }
      )
      const shownAt = await markerSeenAt(page(ctx), `4A-SENT-${tag}`)
      const move = await mutate(
        page(ctx),
        ctx.arm,
        'agentSession.queuedMessageMove',
        largeSessionId,
        { messageId: target.messageId, beforeMessageId: cards[0]!.messageId }
      )
      return {
        hostMs: update.hostMs,
        e2eMs: shownAt - update.startedAt,
        extra: { moveHostMs: move.hostMs }
      }
    })
    await mutate(page(ctx), ctx.arm, 'agentSession.cancel', largeSessionId, {})
    await drainQueue(ctx, largeSessionId)
    return sample
  })
}

/** Stop pauses the queue; resume lets it drain so the next sample starts idle with an empty queue. */
async function drainQueue(ctx: RunContext, sessionId: string): Promise<void> {
  await waitForWorking(page(ctx), false).catch(() => undefined)
  if ((await queued(ctx, sessionId)).length > 0) {
    await mutate(page(ctx), ctx.arm, 'agentSession.queuedMessagesResume', sessionId, {})
  }
  await waitForIdle(page(ctx), sessionId, 300_000)
}
