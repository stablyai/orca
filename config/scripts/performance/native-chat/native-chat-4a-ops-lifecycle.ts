// 4a process-lifecycle rows: first launch on the seeded profile (the candidate's one-time conversion), cold/warm open, and rewind.
import { readdirSync } from 'node:fs'
import path from 'node:path'
import {
  markerSeenAt,
  rendererNow,
  rpc,
  samplePressure,
  storageBytes,
  watchMarkers
} from './native-chat-4a-probes'
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

type Chat = { sessionId: string; worktreeId: string }

/** Open a chat and time it to its known tail marker visible plus controls known. */
async function openTo(ctx: RunContext, chat: Chat, marker: string): Promise<Sample> {
  return measured(ctx, async () => {
    await watchMarkers(page(ctx), [marker])
    const startedAt = await rendererNow(page(ctx))
    await openChatTab(page(ctx), chat.worktreeId, chat.sessionId)
    const tailAt = await markerSeenAt(page(ctx), marker, 600_000)
    await waitForControls(page(ctx), 600_000)
    return {
      e2eMs: (await rendererNow(page(ctx))) - startedAt,
      extra: { tailVisibleMs: tailAt - startedAt }
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

const dbFiles = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.(db|sqlite)$/.test(entry.name) &&
        !entry.parentPath.includes(`${path.sep}home`)
    )
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))

/**
 * The arm's first launch on the seeded profile. On the candidate this is the accepted one-time conversion; on main it is a
 * cold open of the same data, so the rows line up but are reported apart from steady state.
 */
export async function firstLaunchRows(
  ctx: RunContext,
  seedDbFiles: string[],
  label: string
): Promise<void> {
  const { workspace, largeSessionId, fillerSessionIds } = ctx.manifest
  const context = {
    profile: label,
    largeItems: ctx.manifest.largeItems,
    seededBytes: ctx.manifest.storageBytes,
    chats: fillerSessionIds.length + 1
  }
  const init = addRow(ctx, {
    family: 'conversion',
    operation: 'launch to session ready',
    variant: label,
    context
  })
  init.samples.push({ e2eMs: ctx.launch.readyEpochMs - ctx.launch.launchedAtEpochMs })
  const stopPressure = samplePressure(ctx.launch.app, ctx.launch.userDataDir, 500)
  const small: Chat = { sessionId: fillerSessionIds[0]!, worktreeId: workspace.worktreeIds[1] }
  const smallOpen = addRow(ctx, {
    family: 'conversion',
    operation: 'first open, small chat',
    variant: label,
    context
  })
  await sampled(ctx, smallOpen, 1, () =>
    openTo(ctx, small, `4A-TAIL-filler-0-${ctx.workload.history.fillerTurns - 1}`)
  )
  const largeOpen = addRow(ctx, {
    family: 'conversion',
    operation: 'first open, large chat, with sends to the opened small chat',
    variant: label,
    context: { ...context, concurrent: 'sends to the already-opened small chat every 250 ms' }
  })
  let opening = true
  const concurrent: number[] = []
  const sends = (async () => {
    while (opening) {
      concurrent.push(
        (await send(page(ctx), ctx.arm, small.sessionId, replyPrompt(tagFor('during')))).hostMs
      )
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  })()
  await sampled(ctx, largeOpen, 1, () =>
    openTo(
      ctx,
      { sessionId: largeSessionId, worktreeId: workspace.worktreeIds[0] },
      `4A-TAIL-large-${ctx.workload.history.largeTurns - 1}`
    )
  )
  opening = false
  await sends
  const during = addRow(ctx, {
    family: 'conversion',
    operation: 'small-chat send during large first open',
    variant: label,
    context
  })
  during.samples.push(...concurrent.map((hostMs) => ({ hostMs })))
  const pressure = await stopPressure()
  const remaining = dbFiles(ctx.launch.userDataDir)
  const disk = addRow(ctx, {
    family: 'conversion',
    operation: 'disk',
    variant: label,
    context: {
      retainedOriginalFiles:
        seedDbFiles.filter((file) => remaining.includes(file)).join(' ') || 'none',
      newFiles: remaining.filter((file) => !seedDbFiles.includes(file)).join(' ') || 'none'
    }
  })
  disk.samples.push({
    extra: {
      peakTotalBytes: pressure.peakTotalBytes,
      afterTotalBytes: storageBytes(ctx.launch.userDataDir).total,
      peakMainRssBytes: pressure.peakMainRssBytes
    }
  })
  await waitForIdle(page(ctx), small.sessionId)
}

export const seededDbFiles = dbFiles

export async function openRows(ctx: RunContext): Promise<void> {
  const { workspace, largeSessionId, fillerSessionIds } = ctx.manifest
  const large: Chat = { sessionId: largeSessionId, worktreeId: workspace.worktreeIds[0] }
  const small: Chat = { sessionId: fillerSessionIds[0]!, worktreeId: workspace.worktreeIds[1] }
  const marks = { large: await markTail(ctx, large), small: await markTail(ctx, small) }
  const context = { largeItems: ctx.manifest.largeItems, chats: fillerSessionIds.length + 1 }
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
    variant: 'first in process (cold)',
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
  const untouched = fillerSessionIds.slice(3, -1)
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
          (marker) => {
            const root = [...document.querySelectorAll('[data-native-chat-root="true"]')].find(
              (candidate) => candidate.checkVisibility()
            )
            return root && !root.textContent?.includes(marker) ? performance.now() : false
          },
          goneMarker,
          { timeout: 600_000, polling: 16 }
        )
        .then(async (handle) => (await handle.jsonValue()) as number)
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
