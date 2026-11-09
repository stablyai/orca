// 4a streaming rows (1/8/15+ MiB text, no-break and tool output) with a competing send, and the maintenance window after them.
import {
  eventLoopLag,
  markerSeenAt,
  mutationGaps,
  rpc,
  samplePressure,
  storageBytes,
  watchMarkers
} from './native-chat-4a-probes'
import { maintenanceDebtRows } from './native-chat-4a-ops-maintenance'
import { stat, type Sample } from './native-chat-4a-report'
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
  waitForDurable,
  waitForIdle,
  waitForWorking
} from './native-chat-4a-session'
import { replyPrompt, streamPrompt, type StreamCase } from './native-chat-4a-workloads'

const MAINTENANCE_WINDOW_MS = 5_000

/** Wall-clock ms until the durable tail holds `marker`, polling slowly so the reader adds little load to either arm. */
async function durableAfter(
  ctx: RunContext,
  sessionId: string,
  marker: string,
  sentEpochMs: number
): Promise<number> {
  await waitForDurable(page(ctx), sessionId, marker, 300_000, 250)
  return Date.now() - sentEpochMs
}

/** A small send to another chat while the stream runs: its acceptance span and when its reply is durable. */
async function competingSend(
  ctx: RunContext,
  sessionId: string
): Promise<{ hostMs: number; durableMs: number }> {
  const tag = tagFor('compete')
  const sentAt = Date.now()
  const answer = await send(page(ctx), ctx.arm, sessionId, replyPrompt(tag))
  await waitForDurable(page(ctx), sessionId, `4A-TAIL-${tag}`, 300_000, 25)
  return { hostMs: answer.hostMs, durableMs: Date.now() - sentAt }
}

async function streamSample(
  ctx: RunContext,
  shape: StreamCase,
  stopAfterFirst: boolean
): Promise<Sample> {
  const { largeSessionId, fillerSessionIds } = ctx.manifest
  const { launch } = ctx
  // Earlier samples stay in the transcript, so every sample's markers are its own.
  const stream = { ...shape, tag: tagFor(shape.tag) }
  const other = fillerSessionIds[1] ?? fillerSessionIds[0]!
  const before = storageBytes(launch.userDataDir)
  const stopPressure = samplePressure(launch.app, launch.userDataDir)
  const fromEpoch = Date.now()
  const sample = await measured(ctx, async () => {
    const first = `4A-FIRST-${stream.tag}`
    await watchMarkers(page(ctx), [first])
    const sentEpoch = Date.now()
    const answer = await send(
      page(ctx),
      ctx.arm,
      largeSessionId,
      streamPrompt(ctx.workload, stream)
    )
    const firstAt = await markerSeenAt(page(ctx), first, 300_000)
    const [competing, durableFirstMs] = await Promise.all([
      competingSend(ctx, other),
      durableAfter(ctx, largeSessionId, first, sentEpoch)
    ])
    let stopHostMs = Number.NaN
    if (stopAfterFirst) {
      stopHostMs = (await mutate(page(ctx), ctx.arm, 'agentSession.cancel', largeSessionId, {}))
        .hostMs
    }
    const doneAt = await waitForWorking(page(ctx), false, 600_000)
    const settled = await waitForIdle(page(ctx), largeSessionId, 600_000)
    const durableEndMs = Date.now() - sentEpoch
    const gaps = stat(await mutationGaps(page(ctx), firstAt, doneAt))
    return {
      hostMs: answer.hostMs,
      e2eMs: doneAt - answer.startedAt,
      extra: {
        firstTextMs: firstAt - answer.startedAt,
        liveGapP95Ms: gaps?.p95 ?? Number.NaN,
        liveGapMaxMs: gaps?.max ?? Number.NaN,
        durableFirstMs,
        durableSettledMs: durableEndMs,
        competingHostMs: competing.hostMs,
        competingDurableMs: competing.durableMs,
        stopHostMs,
        tailItems: settled.items.length
      }
    }
  })
  const pressure = await stopPressure()
  const after = storageBytes(launch.userDataDir)
  const lag = eventLoopLag(launch.userDataDir, fromEpoch, Date.now())
  return {
    ...sample,
    extra: {
      ...sample.extra,
      walGrowthBytes: after.wal - before.wal,
      fileGrowthBytes: after.total - before.total,
      peakWalBytes: pressure.peakWalBytes,
      peakMainRssBytes: pressure.peakMainRssBytes,
      peakAppWorkingSetBytes: pressure.peakAppWorkingSetBytes,
      eventLoopP99Ms: lag.p99Ms,
      eventLoopMaxMs: lag.maxMs
    }
  }
}

/** After a large stream, sends to another chat and large-chat reads while whatever maintenance follows runs; no debt is asserted. */
async function maintenanceWindow(ctx: RunContext): Promise<Sample[]> {
  const other = ctx.manifest.fillerSessionIds[1] ?? ctx.manifest.fillerSessionIds[0]!
  const fromEpoch = Date.now()
  const samples: Sample[] = []
  while (Date.now() - fromEpoch < MAINTENANCE_WINDOW_MS) {
    const before = storageBytes(ctx.launch.userDataDir)
    const sendAnswer = await send(page(ctx), ctx.arm, other, replyPrompt(tagFor('maint')))
    const read = await history(page(ctx), ctx.manifest.largeSessionId, 'tail', 40)
    const after = storageBytes(ctx.launch.userDataDir)
    samples.push({
      hostMs: sendAnswer.hostMs,
      extra: {
        largeTailReadMs: read.hostMs,
        sinceStreamEndMs: Date.now() - fromEpoch,
        walChangeBytes: after.wal - before.wal,
        fileChangeBytes: after.total - before.total
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  await waitForIdle(page(ctx), other)
  const lag = eventLoopLag(ctx.launch.userDataDir, fromEpoch, Date.now())
  samples.at(-1)!.extra = {
    ...samples.at(-1)!.extra,
    windowEventLoopP99Ms: lag.p99Ms,
    windowEventLoopMaxMs: lag.maxMs
  }
  return samples
}

export async function streamingRows(ctx: RunContext): Promise<void> {
  const { workspace, largeSessionId, largeItems } = ctx.manifest
  await openChatTab(page(ctx), workspace.worktreeIds[0], largeSessionId)
  await waitForControls(page(ctx))
  const samples = ctx.workload.stream.samples
  for (const stream of ctx.workload.stream.cases) {
    const shape = stream.toolOutputBytes
      ? 'tool output running→completed'
      : stream.shape === 'nobreak'
        ? 'no-break block'
        : 'block-rich text'
    const size = `${((stream.toolOutputBytes ?? stream.bytes) / 1024 / 1024).toFixed(2)} MiB`
    const context = {
      encodedBytes: stream.toolOutputBytes ?? stream.bytes,
      chunkBytes: ctx.workload.stream.chunkBytes,
      largeItems,
      concurrent: 'small send in another chat after first text'
    }
    const row = addRow(ctx, { family: 'streaming', operation: shape, variant: size, context })
    await sampled(ctx, row, samples, () => streamSample(ctx, stream, false))
    if (!stream.toolOutputBytes) {
      const stop = addRow(ctx, {
        family: 'streaming',
        operation: `${shape}, Stop after first text`,
        variant: size,
        context
      })
      await sampled(ctx, stop, samples, () => streamSample(ctx, stream, true))
    }
    const maintenance = addRow(ctx, {
      family: 'maintenance',
      operation: 'other-chat sends and large-chat reads after stream',
      variant: size,
      context: {
        windowMs: MAINTENANCE_WINDOW_MS,
        // The stream's final body stays current; retired-data debt is measured in the maintenance module.
        precedingStreamBytes: stream.toolOutputBytes ?? stream.bytes
      }
    })
    try {
      maintenance.samples.push(...(await maintenanceWindow(ctx)))
    } catch (error) {
      maintenance.skipped =
        `failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300)
    }
  }
  await maintenanceDebtRows(ctx)
  // A cheap read after all streams confirms the large chat still answers its tail.
  await rpc(page(ctx), 'agentSession.history', {
    sessionId: largeSessionId,
    direction: 'tail',
    limit: 1
  })
}
