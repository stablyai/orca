// R3's retained-history rows: queued-send admission and resume after a Stop pause, live queue small, released history growing.
import { markerSeenAt, watchMarkers } from './native-chat-4a-probes'
import {
  addRow,
  measured,
  page,
  sampled,
  tagFor,
  type RunContext
} from './native-chat-4a-run-context'
import {
  mutate,
  openChatTab,
  send,
  waitForControls,
  waitForIdle,
  waitForWorking
} from './native-chat-4a-session'
import { holdPrompt, replyPrompt } from './native-chat-4a-workloads'
import { holdActive, queued, sentText } from './native-chat-4a-ops-queue'

/** R3: grow released queue history in batches, then measure admission with `liveQueue` waiting at each checkpoint. */
export async function retainedAdmissionRows(ctx: RunContext): Promise<void> {
  const { workspace, fillerSessionIds, largeSessionId } = ctx.manifest
  const chat = fillerSessionIds[2] ?? fillerSessionIds[0]!
  const { checkpoints, liveQueue } = ctx.workload.retained
  const targets: { sessionId: string; worktreeId: string; released: number | 'seeded' }[] = [
    { sessionId: largeSessionId, worktreeId: workspace.worktreeIds[0], released: 'seeded' },
    ...checkpoints.map((released) => ({
      sessionId: chat,
      worktreeId: workspace.worktreeIds[1],
      released
    }))
  ]
  let released = 0
  for (const target of targets) {
    if (typeof target.released === 'number') {
      while (released < target.released) {
        const batch = Math.min(10, target.released - released)
        await send(page(ctx), ctx.arm, chat, holdPrompt(tagFor('grow'), 100))
        for (let index = 0; index < batch; index += 1) {
          await send(page(ctx), ctx.arm, chat, replyPrompt(tagFor('released')))
        }
        await waitForIdle(page(ctx), chat, 300_000)
        released += batch
      }
    }
    await openChatTab(page(ctx), target.worktreeId, target.sessionId)
    await waitForControls(page(ctx))
    const context = {
      releasedHistory: String(target.released),
      liveQueue,
      chat: target.sessionId === largeSessionId ? 'large (seeded queue history)' : 'small'
    }
    const admit = addRow(ctx, {
      family: 'retained history',
      operation: 'queued-send admission',
      variant: `released=${target.released}`,
      context
    })
    const resume = addRow(ctx, {
      family: 'retained history',
      operation: 'resume after Stop pause',
      variant: `released=${target.released}`,
      context
    })
    await sampled(ctx, admit, ctx.workload.samples, async () => {
      await holdActive(ctx, target.sessionId, 60_000)
      for (let index = 0; index < liveQueue - 1; index += 1) {
        await send(page(ctx), ctx.arm, target.sessionId, replyPrompt(tagFor('live')))
      }
      const tag = tagFor('admit')
      await watchMarkers(page(ctx), [`4A-SENT-${tag}`])
      const sample = await measured(ctx, async () => {
        const answer = await send(page(ctx), ctx.arm, target.sessionId, sentText(tag))
        return {
          hostMs: answer.hostMs,
          e2eMs: (await markerSeenAt(page(ctx), `4A-SENT-${tag}`)) - answer.startedAt
        }
      })
      await mutate(page(ctx), ctx.arm, 'agentSession.cancel', target.sessionId, {})
      await waitForWorking(page(ctx), false)
      const last = (await queued(ctx, target.sessionId)).length
      resume.samples.push(
        await measured(ctx, async () => ({
          hostMs: (
            await mutate(
              page(ctx),
              ctx.arm,
              'agentSession.queuedMessagesResume',
              target.sessionId,
              {}
            )
          ).hostMs,
          extra: { pausedQueueLength: last }
        }))
      )
      await waitForIdle(page(ctx), target.sessionId, 300_000)
      return sample
    })
  }
}
