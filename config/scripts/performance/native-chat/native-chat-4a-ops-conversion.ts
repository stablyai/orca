// 4a one-time conversion rows, reported apart from steady state. Ready is the candidate's existing epoch-installed boundary,
import path from 'node:path'
import { seededChats, unconvertedOpenTarget } from './native-chat-4a-fixture'
import { openTo, type Chat } from './native-chat-4a-ops-lifecycle'
import { samplePressure, storageBytes } from './native-chat-4a-probes'
import type { Row, Sample } from './native-chat-4a-report'
import { addRow, page, sampled, tagFor, type RunContext } from './native-chat-4a-run-context'
import { send, waitForIdle } from './native-chat-4a-session'
import {
  CHAT_STATE_CODE,
  seededDbFiles,
  type ChatState,
  type ConversionObserver
} from './native-chat-4a-sqlite-observer'
import { replyPrompt } from './native-chat-4a-workloads'

const SWEEP_TIMEOUT_MS = 2 * 60 * 60_000
const NO_DOMAIN_DATABASE =
  'this arm created no agent-session-domain.db by session ready: nothing converts'

function observation(observer: ConversionObserver): Record<string, number | string> {
  return {
    observedDatabase: observer.databaseFile
      ? path.basename(observer.databaseFile)
      : 'none (no agent-session-domain.db)',
    readyBoundary: 'journal_chat_state.epoch installed, first poll that sees it',
    observationResolutionMs: observer.resolutionMs
  }
}

/** Open a chat for the first time, reading its conversion state before the open and once the open has been requested. */
async function firstOpen(
  ctx: RunContext,
  observer: ConversionObserver,
  chat: Chat,
  marker: string
): Promise<{ sample: Sample; atOpen: ChatState }> {
  const before = observer.state(chat.sessionId)
  let atOpen: ChatState = before
  const requestedAt = Date.now()
  const sample = await openTo(ctx, chat, marker, () => {
    // Ready marks never revert, so a pending read here proves the chat was unconverted when the open began.
    atOpen = observer.state(chat.sessionId)
    return {
      stateBeforeOpen: CHAT_STATE_CODE[before],
      stateAtOpen: CHAT_STATE_CODE[atOpen]
    }
  })
  observer.state(chat.sessionId)
  const readyAt = observer.readyAt.get(chat.sessionId)
  sample.extra = {
    ...sample.extra,
    readyMarkMs: readyAt === undefined || before === 'ready' ? Number.NaN : readyAt - requestedAt
  }
  return { sample, atOpen }
}

/**
 * The arm's first launch on the seeded profile. On the candidate this is the accepted one-time conversion; on main it is a
 * cold open of the same data, so the rows line up but are reported apart from steady state.
 */
export async function firstLaunchRows(
  ctx: RunContext,
  seedDbFiles: string[],
  label: string,
  observer: ConversionObserver
): Promise<void> {
  const { workspace, largeSessionId, fillerSessionIds } = ctx.manifest
  const context = {
    profile: label,
    largeItems: ctx.manifest.largeItems,
    seededBytes: ctx.manifest.storageBytes,
    chats: seededChats(ctx.manifest).length,
    ...observation(observer)
  }
  const init = addRow(ctx, {
    family: 'conversion',
    operation: 'launch to session ready',
    variant: label,
    context
  })
  init.samples.push({ e2eMs: ctx.launch.readyEpochMs - ctx.launch.launchedAtEpochMs })
  const stopPressure = samplePressure(ctx.launch.app, ctx.launch.userDataDir, 500)
  const target = unconvertedOpenTarget(ctx.manifest)
  const unconverted = addRow(ctx, {
    family: 'conversion',
    operation: 'first open, unconverted chat (last in sweep order)',
    variant: label,
    context: { ...context, stateCodes: 'NaN no domain db, 0 pending, 1 importing, 2 ready' }
  })
  if (!target) {
    unconverted.skipped = 'profile has no untouched filler chat to open unconverted'
  } else {
    const index = fillerSessionIds.indexOf(target)
    await sampled(ctx, unconverted, 1, async () => {
      const { sample, atOpen } = await firstOpen(
        ctx,
        observer,
        { sessionId: target, worktreeId: workspace.worktreeIds[1] },
        `4A-TAIL-filler-${index}-${ctx.workload.history.fillerTurns - 1}`
      )
      if (atOpen === 'ready' || atOpen === 'uncatalogued') {
        addRow(ctx, {
          family: 'conversion',
          operation: `first open, chat ${atOpen === 'ready' ? 'converted' : 'uncatalogued'} before open`,
          variant: label,
          context,
          samples: [sample]
        })
        throw new Error(`target was ${atOpen} when the open began; not an unconverted open`)
      }
      return sample
    })
  }
  const small: Chat = { sessionId: fillerSessionIds[0]!, worktreeId: workspace.worktreeIds[1] }
  const smallOpen = addRow(ctx, {
    family: 'conversion',
    operation: 'first open, small chat',
    variant: label,
    context
  })
  const openOnce = (chat: Chat, marker: string) => async () =>
    (await firstOpen(ctx, observer, chat, marker)).sample
  await sampled(
    ctx,
    smallOpen,
    1,
    openOnce(small, `4A-TAIL-filler-0-${ctx.workload.history.fillerTurns - 1}`)
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
  await sampled(
    ctx,
    largeOpen,
    1,
    openOnce(
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
  const remaining = seededDbFiles(ctx.launch.userDataDir)
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

/** Steady-state families start only once every seeded chat is ready, so import never mixes into their samples. */
export async function awaitSweep(
  ctx: RunContext,
  observer: ConversionObserver,
  label: string
): Promise<boolean> {
  try {
    if (!observer.databaseFile) {
      return true
    }
    const started = Date.now()
    const done = await observer.allReady(seededChats(ctx.manifest), SWEEP_TIMEOUT_MS)
    const row = addRow(ctx, {
      family: 'conversion',
      operation: 'wait for every chat ready before steady-state families',
      variant: label,
      context: observation(observer)
    })
    if (!done) {
      row.skipped = `not every seeded chat was ready after ${SWEEP_TIMEOUT_MS} ms; dependent steady-state families skipped`
      ctx.log(`${ctx.arm.name}: ${row.skipped}`)
      return false
    }
    row.samples.push({ e2eMs: Date.now() - started })
    return true
  } finally {
    await observer.stop()
  }
}

/** Idle launch on its own seed copy: launch to the last ready mark, and each chat's ready-mark interval in observed order. */
export async function sweepRows(
  ctx: RunContext,
  observer: ConversionObserver,
  label: string
): Promise<void> {
  const { manifest, launch } = ctx
  const chats = seededChats(manifest)
  const context = {
    profile: label,
    chats: chats.length,
    completedDiffChat: manifest.diffChat.sessionId,
    activity: 'none: the app stays idle until the last ready mark',
    endPoints:
      "previous chat's ready mark → this chat's ready mark in observed order; includes the sweep's idle-boundary waits",
    ...observation(observer)
  }
  const row = (operation: string, extra: Record<string, number | string> = {}): Row =>
    addRow(ctx, {
      family: 'conversion',
      operation,
      variant: label,
      context: { ...context, ...extra }
    })
  const whole = row('background sweep, launch to every chat ready')
  const diff = manifest.diffChat
  const small = manifest.fillerSessionIds.filter((id) => id !== diff.sessionId)
  const sized = [
    { name: 'small chats', ids: small, items: 'filler recipe' },
    {
      name: 'completed-diff chat',
      ids: [diff.sessionId],
      items: `filler recipe + ${diff.itemIds.length} × ${diff.patchBytes} B diff originals`
    },
    {
      name: 'medium chat',
      ids: manifest.mediumSessionId ? [manifest.mediumSessionId] : [],
      items: manifest.mediumItems
    },
    {
      name: `${manifest.largeItems}-item chat`,
      ids: [manifest.largeSessionId],
      items: manifest.largeItems
    }
  ]
  const intervalRows = sized.map((size) => ({
    ...size,
    row: row(`background sweep ready-mark interval, ${size.name}`, { items: size.items })
  }))
  if (!observer.databaseFile) {
    for (const each of [whole, ...intervalRows.map((entry) => entry.row)]) {
      each.skipped = NO_DOMAIN_DATABASE
    }
    return
  }
  const done = await observer.allReady(chats, SWEEP_TIMEOUT_MS)
  const readyAt = (id: string): number => observer.readyAt.get(id)!
  const ordered = chats
    .filter((id) => observer.readyAt.has(id))
    .sort((a, b) => readyAt(a) - readyAt(b) || (a < b ? -1 : 1))
  const interval = new Map<string, number>()
  let previous = observer.databaseSeenAt
  for (const id of ordered) {
    interval.set(id, readyAt(id) - previous)
    previous = readyAt(id)
  }
  if (!done) {
    whole.skipped = `${ordered.length} of ${chats.length} chats ready after ${SWEEP_TIMEOUT_MS} ms`
  } else {
    whole.samples.push({
      e2eMs: readyAt(ordered.at(-1)!) - launch.launchedAtEpochMs,
      extra: {
        sessionReadyMs: launch.readyEpochMs - launch.launchedAtEpochMs,
        storeSeenMs: observer.databaseSeenAt - launch.launchedAtEpochMs,
        readyBySessionReady: ordered.filter((id) => readyAt(id) <= launch.readyEpochMs).length,
        readyOutOfSweepOrder: ordered.filter((id, index) => index > 0 && id < ordered[index - 1]!)
          .length,
        catalogRows: observer.catalogRows
      }
    })
  }
  for (const { ids, row: sizeRow, name } of intervalRows) {
    const spans = ids.flatMap((id) => (interval.has(id) ? [interval.get(id)!] : []))
    if (ids.length === 0) {
      sizeRow.skipped = `profile seeds no ${name}`
      continue
    }
    if (spans.length < ids.length) {
      sizeRow.skipped = `${ids.length - spans.length} of ${ids.length} ${name} not seen ready`
      continue
    }
    sizeRow.samples.push(...spans.map((e2eMs) => ({ e2eMs })))
    const total = spans.reduce((sum, span) => sum + span, 0)
    sizeRow.context = {
      ...sizeRow.context,
      totalSpanMs: total,
      meanMs: spans.length ? Math.round((total / spans.length) * 100) / 100 : Number.NaN
    }
  }
}
