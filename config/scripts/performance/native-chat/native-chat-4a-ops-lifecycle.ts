// 4a process-lifecycle rows: cold/warm open and rewind; first launch on the seeded profile lives in the conversion module.
import { composerEnabledAt, unwatchMarker } from './native-chat-4a-visibility'
import { seededChats, unconvertedOpenTarget } from './native-chat-4a-fixture'
import { markerSeenAt, rendererNow, rendererTime, rpc, watchMarkers } from './native-chat-4a-probes'
import type { Sample } from './native-chat-4a-report'
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
  messageItemIds,
  waitForControls,
  waitForDurable,
  waitForIdle
} from './native-chat-4a-session'
import { replyPrompt } from './native-chat-4a-workloads'

export type Chat = { sessionId: string; worktreeId: string }

/** Open a chat and time it to its known tail marker visible plus controls known; `issued` runs once the open is requested. */
export async function openTo(
  ctx: RunContext,
  chat: Chat,
  marker: string,
  issued?: () => Record<string, number>
): Promise<Sample> {
  return measured(ctx, async () => {
    const startedAt = await rendererNow(page(ctx))
    await watchMarkers(page(ctx), [marker], true)
    try {
      await openChatTab(page(ctx), chat.worktreeId, chat.sessionId)
      const observed = issued?.() ?? {}
      const [tailAt, composerAt] = await Promise.all([
        markerSeenAt(page(ctx), marker, 600_000),
        composerEnabledAt(page(ctx), marker, 600_000)
      ])
      const driverAt = await rendererNow(page(ctx))
      return {
        e2eMs: Math.max(tailAt, composerAt) - startedAt,
        extra: {
          tailVisibleMs: tailAt - startedAt,
          composerEnabledMs: composerAt - startedAt,
          driverCompletionMs: driverAt - startedAt,
          ...observed
        }
      }
    } finally {
      await unwatchMarker(page(ctx), marker)
    }
  })
}

/** Give a chat a known tail so open rows end at "the correct tail is visible". */
async function markTail(ctx: RunContext, chat: Chat): Promise<string> {
  const tag = tagFor('tail')
  await send(page(ctx), ctx.arm, chat.sessionId, replyPrompt(tag))
  await waitForDurable(page(ctx), chat.sessionId, `4A-TAIL-${tag}`)
  await waitForIdle(page(ctx), chat.sessionId)
  return `4A-TAIL-${tag}`
}

export async function openRows(ctx: RunContext): Promise<void> {
  const { workspace, largeSessionId, fillerSessionIds } = ctx.manifest
  const large: Chat = { sessionId: largeSessionId, worktreeId: workspace.worktreeIds[0] }
  const small: Chat = { sessionId: fillerSessionIds[0]!, worktreeId: workspace.worktreeIds[1] }
  const marks = { large: await markTail(ctx, large), small: await markTail(ctx, small) }
  const context = { largeItems: ctx.manifest.largeItems, chats: seededChats(ctx.manifest).length }
  const ready = addRow(ctx, {
    family: 'open',
    operation: 'launch to session ready (metadata only)',
    variant: 'converted profile',
    context
  })
  const coldLarge = addRow(ctx, {
    family: 'open',
    operation: 'cold process first open',
    variant: 'large chat',
    context
  })
  const coldSmall = addRow(ctx, {
    family: 'open',
    operation: 'cold process first open',
    variant: 'small chat',
    context
  })
  const coldOutline = addRow(ctx, {
    family: 'outline',
    operation: 'conversationOutline',
    variant: 'first in process (persisted cache unclassified)',
    context
  })
  // A third chat is left active, so the relaunch restores it and the measured chats open for the first time.
  const neutral: Chat = {
    sessionId: fillerSessionIds[2] ?? fillerSessionIds.at(-1)!,
    worktreeId: workspace.worktreeIds[1]
  }
  for (let launch = 0; launch < ctx.workload.coldSamples; launch += 1) {
    await openChatTab(page(ctx), neutral.worktreeId, neutral.sessionId)
    await ctx.relaunch()
    ready.samples.push({ e2eMs: ctx.launch.readyEpochMs - ctx.launch.launchedAtEpochMs })
    const [first, second, firstRow, secondRow] =
      launch % 2 === 0 ? [large, small, coldLarge, coldSmall] : [small, large, coldSmall, coldLarge]
    await sampled(ctx, firstRow, 1, () =>
      openTo(ctx, first, first === large ? marks.large : marks.small)
    )
    await sampled(ctx, secondRow, 1, () =>
      openTo(ctx, second, second === large ? marks.large : marks.small)
    )
    await sampled(ctx, coldOutline, 1, () =>
      measured(ctx, async () => ({
        hostMs: (
          await rpc(page(ctx), 'agentSession.conversationOutline', { sessionId: largeSessionId })
        ).hostMs
      }))
    )
  }
  const unopened = addRow(ctx, {
    family: 'open',
    operation: 'warm process, unopened chat',
    variant: 'small chat',
    context
  })
  // The conversion family's unconverted-open target is already open.
  const target = unconvertedOpenTarget(ctx.manifest)
  const untouched = fillerSessionIds.slice(3, -1).filter((id) => id !== target)
  if (untouched.length === 0) {
    unopened.skipped = 'profile has no filler chat left untouched by earlier families'
  }
  await sampled(ctx, unopened, Math.min(ctx.workload.samples, untouched.length), (index) => {
    const chat = { sessionId: untouched[index]!, worktreeId: workspace.worktreeIds[1] }
    const chatIndex = fillerSessionIds.indexOf(chat.sessionId)
    return openTo(ctx, chat, `4A-TAIL-filler-${chatIndex}-${ctx.workload.history.fillerTurns - 1}`)
  })
  for (const [variant, chat, marker] of [
    ['large chat', large, marks.large],
    ['small chat', small, marks.small]
  ] as const) {
    const reopen = addRow(ctx, { family: 'open', operation: 'warm reopen', variant, context })
    await sampled(ctx, reopen, ctx.workload.samples, async () => {
      await openChatTab(
        page(ctx),
        (chat === large ? small : large).worktreeId,
        (chat === large ? small : large).sessionId
      )
      return openTo(ctx, chat, marker)
    })
  }
}

/** Near-tip and deep rewinds on the large chat, with a competing send to another chat while the local writer cuts. */
export async function rewindRows(ctx: RunContext): Promise<void> {
  const { workspace, largeSessionId, fillerSessionIds } = ctx.manifest
  const other = fillerSessionIds[1] ?? fillerSessionIds[0]!
  await openChatTab(page(ctx), workspace.worktreeIds[0], largeSessionId)
  await waitForControls(page(ctx))
  const rewindOnce = async (itemId: string, goneMarker: string): Promise<Sample> => {
    const epoch = (await history(page(ctx), largeSessionId, 'tail', 1)).page.epoch
    const markerLocator = page(ctx).getByText(goneMarker, { exact: false }).last()
    await markerLocator.waitFor({ state: 'visible' })
    const markerElement = await markerLocator.elementHandle()
    if (!markerElement) {
      throw new Error('rewind marker not mounted')
    }
    return measured(ctx, async () => {
      const competingTag = tagFor('rewind-compete')
      const [answer, competing] = await Promise.all([
        mutate(page(ctx), ctx.arm, 'agentSession.rewind', largeSessionId, {
          itemId,
          expectedEpoch: epoch
        }),
        send(page(ctx), ctx.arm, other, replyPrompt(competingTag))
      ])
      const goneAt = await page(ctx)
        .waitForFunction(
          (element) =>
            !element.isConnected || !element.checkVisibility() ? performance.now() : false,
          markerElement,
          { timeout: 600_000, polling: 16 }
        )
        .then(rendererTime)
      await markerElement.dispose()
      await waitForDurable(page(ctx), other, `4A-TAIL-${competingTag}`)
      return {
        hostMs: answer.hostMs,
        e2eMs: goneAt - answer.startedAt,
        extra: { competingSendHostMs: competing.hostMs }
      }
    })
  }
  const endToEndOnly = 'preflight, provider success and local cut are one host span'
  const nearTip = addRow(ctx, {
    family: 'rewind',
    operation: 'near-tip rewind',
    variant: 'last turn',
    context: { largeItems: ctx.manifest.largeItems },
    endToEndOnly
  })
  await sampled(ctx, nearTip, ctx.workload.rewind.nearTipSamples, async () => {
    const marker = await markTail(ctx, {
      sessionId: largeSessionId,
      worktreeId: workspace.worktreeIds[0]
    })
    const [tip] = (await messageItemIds(page(ctx), largeSessionId, 'user', 1)).slice(-1)
    return rewindOnce(tip!, marker)
  })
  const cut = ctx.workload.rewind.deepCutTurns
  const deep = addRow(ctx, {
    family: 'rewind',
    operation: 'deep rewind',
    variant: `${cut} turns from tip`,
    context: { removedTurns: cut },
    endToEndOnly
  })
  await sampled(ctx, deep, ctx.workload.rewind.deepSamples, async () => {
    const ids = await messageItemIds(page(ctx), largeSessionId, 'user', cut + 1)
    const tail = JSON.stringify(
      (await history(page(ctx), largeSessionId, 'tail', 3)).page.items
    ).match(/4A-TAIL-[\w-]+/)?.[0]
    if (ids.length <= cut || !tail) {
      throw new Error(`large chat has ${ids.length} user turns left, deep cut needs ${cut + 1}`)
    }
    return rewindOnce(ids[0]!, tail)
  })
}
