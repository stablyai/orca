// Live large-body and new-tool contention, synchronized to observed work instead of the first stream marker.
import { eventLoopLag, samplePressure, storageBytes } from './native-chat-4a-probes'
import {
  measured,
  page,
  sampled,
  addRow,
  tagFor,
  type RunContext
} from './native-chat-4a-run-context'
import {
  history,
  mutate,
  send,
  waitForDurable,
  waitForIdle,
  waitForWorking
} from './native-chat-4a-session'
import { chatDatabasePath } from './native-chat-4a-sqlite-observer'
import { streamTextObserver } from './native-chat-4a-source-observer'
import {
  replyPrompt,
  streamPrompt,
  toolBurstPrompt,
  type StreamCase
} from './native-chat-4a-workloads'
import type { Sample } from './native-chat-4a-report'

export async function competingSend(
  ctx: RunContext,
  sessionId: string,
  beforeRequest?: () => void
): Promise<{ hostMs: number; durableMs: number }> {
  const tag = tagFor('compete')
  const sentAt = Date.now()
  const answer = await send(page(ctx), ctx.arm, sessionId, replyPrompt(tag), true, beforeRequest)
  await waitForDurable(page(ctx), sessionId, `4A-TAIL-${tag}`, 300_000, 25)
  return { hostMs: answer.hostMs, durableMs: Date.now() - sentAt }
}

export async function phaseSample(
  ctx: RunContext,
  shape: StreamCase['shape'],
  threshold: number
): Promise<Sample> {
  const sessionId = ctx.manifest.largeSessionId
  const other = ctx.manifest.fillerSessionIds[1] ?? ctx.manifest.fillerSessionIds[0]!
  const file = chatDatabasePath(ctx.launch.userDataDir)
  if (!file) {
    throw new Error('no chat database for current-body observation')
  }
  const stream = { tag: tagFor('phase'), shape, bytes: threshold + 1024 ** 2 }
  const observer = streamTextObserver(file, sessionId, `4A-FIRST-${stream.tag}`)
  const stopPressure = samplePressure(ctx.launch.app, ctx.launch.userDataDir)
  const before = storageBytes(ctx.launch.userDataDir)
  const started = Date.now()
  let pressure
  let sample
  try {
    sample = await measured(ctx, async () => {
      const sent = await send(page(ctx), ctx.arm, sessionId, streamPrompt(ctx.workload, stream))
      const deadline = Date.now() + 600_000
      let observed = observer.read()
      while (observed.bytes < threshold && !observed.completed && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        observed = observer.read()
      }
      if (observed.bytes < threshold || observed.bytes >= stream.bytes || observed.completed) {
        throw new Error(
          `live threshold missed: ${observed.bytes} bytes, completed=${observed.completed}`
        )
      }
      const triggerMs = Date.now() - started
      let sendCurrentTextBytes = Number.NaN
      let stopCurrentTextBytes = Number.NaN
      const readCurrentTextBytes = observer.read().bytes
      const [competing, read, stop] = await Promise.all([
        competingSend(ctx, other, () => {
          sendCurrentTextBytes = observer.read().bytes
        }),
        history(page(ctx), sessionId, 'tail', 40),
        mutate(page(ctx), ctx.arm, 'agentSession.cancel', sessionId, {}, () => {
          stopCurrentTextBytes = observer.read().bytes
        })
      ])
      const done = await waitForWorking(page(ctx), false, 600_000)
      await waitForIdle(page(ctx), sessionId, 600_000)
      const afterStop = observer.read()
      return {
        hostMs: sent.hostMs,
        e2eMs: done - sent.startedAt,
        extra: {
          thresholdBytes: threshold,
          currentTextBytesAtTrigger: observed.bytes,
          currentTextBytesAfterStop: afterStop.bytes,
          triggerMs,
          sendCurrentTextBytes,
          readCurrentTextBytes,
          stopCurrentTextBytes,
          competingHostMs: competing.hostMs,
          competingDurableMs: competing.durableMs,
          competingTailReadMs: read.hostMs,
          competingTailItems: read.page.items.length,
          stopHostMs: stop.hostMs
        }
      }
    })
  } finally {
    observer.close()
    pressure = await stopPressure()
  }
  const after = storageBytes(ctx.launch.userDataDir)
  const lag = eventLoopLag(ctx.launch.userDataDir, started, Date.now())
  return {
    ...sample,
    extra: {
      ...sample.extra,
      peakWalBytes: pressure.peakWalBytes,
      peakTotalBytes: pressure.peakTotalBytes,
      walGrowthBytes: after.wal - before.wal,
      fileGrowthBytes: after.total - before.total,
      eventLoopP99Ms: lag.p99Ms,
      eventLoopMaxMs: lag.maxMs
    }
  }
}

export async function liveToolBurstRows(ctx: RunContext): Promise<void> {
  const sessionId = ctx.manifest.largeSessionId
  const other = ctx.manifest.fillerSessionIds[1] ?? ctx.manifest.fillerSessionIds[0]!
  const row = addRow(ctx, {
    family: 'streaming',
    operation: 'live eight-tool burst with competing send',
    variant: 'large retained chat',
    context: {
      tools: 8,
      toolRunMs: 250,
      largeItems: ctx.manifest.largeItems,
      toolOutputBytes: ctx.workload.history.toolOutputBytes,
      concurrent: 'other-chat send after first new running tool observed'
    }
  })
  await sampled(ctx, row, ctx.workload.stream.samples, async () => {
    const existing = new Set(
      (await history(page(ctx), sessionId, 'tail', 40)).page.items.map((item) => item.itemId)
    )
    const tag = tagFor('burst')
    const stopPressure = samplePressure(ctx.launch.app, ctx.launch.userDataDir)
    let pressure
    let sample
    try {
      sample = await measured(ctx, async () => {
        const sent = await send(page(ctx), ctx.arm, sessionId, toolBurstPrompt(ctx.workload, tag))
        const deadline = Date.now() + 300_000
        let live = 0
        while (Date.now() < deadline) {
          const tail = await history(page(ctx), sessionId, 'tail', 40)
          live = tail.page.items.filter(
            (item) =>
              !existing.has(item.itemId) &&
              item.body?.kind === 'tool-call' &&
              item.body.state === 'running'
          ).length
          if (live > 0) {
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        if (live === 0) {
          throw new Error('no new running tool observed; live contention not exercised')
        }
        const [otherSend, settled] = await Promise.all([
          competingSend(ctx, other),
          (async () => {
            await waitForDurable(page(ctx), sessionId, `4A-TAIL-${tag}`, 300_000, 25)
            const tail = await waitForIdle(page(ctx), sessionId, 300_000)
            const completed = tail.items.filter(
              (item) =>
                !existing.has(item.itemId) &&
                item.body?.kind === 'tool-call' &&
                item.body.state === 'completed'
            ).length
            if (completed !== 8) {
              throw new Error(`burst completed ${completed} tools, expected 8`)
            }
            const done = await waitForWorking(page(ctx), false, 300_000)
            return { completed, done }
          })()
        ])
        return {
          hostMs: sent.hostMs,
          e2eMs: settled.done - sent.startedAt,
          extra: {
            observedRunningToolsAtCompetingSend: live,
            completedTools: settled.completed,
            competingHostMs: otherSend.hostMs,
            competingDurableMs: otherSend.durableMs
          }
        }
      })
    } finally {
      pressure = await stopPressure()
    }
    return {
      ...sample,
      extra: {
        ...sample.extra,
        peakWalBytes: pressure.peakWalBytes,
        peakTotalBytes: pressure.peakTotalBytes
      }
    }
  })
}
