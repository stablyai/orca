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
import { streamTextObserver, runningToolsObserver } from './native-chat-4a-source-observer'
import {
  replyPrompt,
  streamPrompt,
  toolBurstPrompt,
  type StreamCase
} from './native-chat-4a-workloads'
import type { Sample } from './native-chat-4a-report'
import { burstCallIds, completedBurst } from './native-chat-4a-burst-history'

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
      const liveSize = (operation: string): number => {
        const current = observer.read()
        if (current.bytes < threshold || current.bytes >= stream.bytes || current.completed) {
          throw new Error(
            `${operation} missed live phase: ${current.bytes} bytes, completed=${current.completed}`
          )
        }
        return current.bytes
      }
      const triggerMs = Date.now() - started
      let sendCurrentTextBytes = Number.NaN
      let stopCurrentTextBytes = Number.NaN
      const readCurrentTextBytes = liveSize('tail read')
      const [competing, read, stop] = await Promise.all([
        competingSend(ctx, other, () => {
          sendCurrentTextBytes = liveSize('competing send')
        }),
        history(page(ctx), sessionId, 'tail', 40),
        (async () => {
          const requestedAt = Date.now()
          const answer = await mutate(
            page(ctx),
            ctx.arm,
            'agentSession.cancel',
            sessionId,
            {},
            () => {
              stopCurrentTextBytes = liveSize('Stop')
            }
          )
          const actionMs = Date.now() - requestedAt
          const doneAt = await waitForWorking(page(ctx), false, 600_000)
          await waitForIdle(page(ctx), sessionId, 600_000)
          return { ...answer, actionMs, doneAt, settledMs: Date.now() - requestedAt }
        })()
      ])
      const afterStop = observer.read()
      return {
        hostMs: sent.hostMs,
        e2eMs: stop.doneAt - sent.startedAt,
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
          stopHostMs: stop.hostMs,
          stopActionMs: stop.actionMs,
          stopSettledMs: stop.settledMs
        }
      }
    })
  } catch (error) {
    await mutate(page(ctx), ctx.arm, 'agentSession.cancel', sessionId, {}).catch(() => undefined)
    await waitForIdle(page(ctx), sessionId, 600_000).catch(() => undefined)
    throw error
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
    operation: 'live serial eight-tool burst with competing send',
    variant: 'large retained chat',
    context: {
      tools: 8,
      toolRunMs: 250,
      largeItems: ctx.manifest.largeItems,
      toolOutputBytes: ctx.workload.history.toolOutputBytes,
      concurrent: 'other-chat send with a post-fence, read-only running-tool witness at dispatch',
      observation: 'latest 40 post-baseline source rows; newest revision per item; no held snapshot'
    }
  })
  await sampled(ctx, row, ctx.workload.stream.samples, async (index) => {
    const file = chatDatabasePath(ctx.launch.userDataDir)
    if (!file) {
      throw new Error('no chat database; live contention not exercised')
    }
    const tag = tagFor('burst')
    const expected = burstCallIds(tag)
    const observer = runningToolsObserver(file, sessionId, expected)
    const runningTools = () => observer.read()
    const stopPressure = samplePressure(ctx.launch.app, ctx.launch.userDataDir)
    let pressure
    let sample
    try {
      sample = await measured(ctx, async () => {
        const sent = await send(page(ctx), ctx.arm, sessionId, toolBurstPrompt(ctx.workload, tag))
        const deadline = Date.now() + 300_000
        let live = runningTools()
        while (live.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25))
          live = runningTools()
        }
        if (live.length === 0) {
          throw new Error('no new running tool observed; live contention not exercised')
        }
        const [otherSend, settled] = await Promise.allSettled([
          competingSend(ctx, other, () => {
            live = runningTools()
            row.context[`observedRunningToolsAtCompetingSend.sample${index + 1}`] = JSON.stringify({
              sessionId,
              epoch: observer.epoch,
              afterPosition: observer.position,
              burstTag: tag,
              expectedCallIds: expected,
              count: live.length,
              itemIds: live
            })
            if (live.length === 0) {
              throw new Error(
                'no new running tool at competing-send dispatch; contention unexercised'
              )
            }
          }),
          (async () => {
            await waitForDurable(page(ctx), sessionId, `4A-TAIL-${tag}`, 300_000, 25)
            await waitForIdle(page(ctx), sessionId, 300_000)
            const proof = await completedBurst(page(ctx), sessionId, expected)
            row.context[`completedBurst.sample${index + 1}`] = JSON.stringify(proof)
            const done = await waitForWorking(page(ctx), false, 300_000)
            return { completed: proof.completed, done }
          })()
        ])
        if (otherSend.status === 'rejected') {
          throw otherSend.reason
        }
        if (settled.status === 'rejected') {
          throw settled.reason
        }
        return {
          hostMs: sent.hostMs,
          e2eMs: settled.value.done - sent.startedAt,
          extra: {
            observedRunningToolsAtCompetingSend: live.length,
            completedTools: settled.value.completed,
            competingHostMs: otherSend.value.hostMs,
            competingDurableMs: otherSend.value.durableMs
          }
        }
      })
    } finally {
      observer.close()
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
