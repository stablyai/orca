// One fork in the existing campaign under unrelated retired-history debt, with a concurrent send and sampled disk peaks.
import path from 'node:path'
import { existsSync, renameSync } from 'node:fs'
import { copyProfile } from './native-chat-4a-arm'
import { samplePressure, storageBytes, rendererNow } from './native-chat-4a-probes'
import {
  prepareRetiredHistory,
  retiredHistory,
  type RetiredHistory
} from './native-chat-4a-retired-fixture'
import {
  addRow,
  measured,
  page,
  sampled,
  tagFor,
  type RunContext
} from './native-chat-4a-run-context'
import { createChat, history, messageItemIds, waitForIdle } from './native-chat-4a-session'
import { chatDatabasePath } from './native-chat-4a-sqlite-observer'
import { competingSend } from './native-chat-4a-ops-stream-contention'

export async function forkPressureRows(ctx: RunContext): Promise<void> {
  const { largeSessionId, fillerSessionIds, workspace, largeItems } = ctx.manifest
  const unrelated = fillerSessionIds[2] ?? fillerSessionIds.at(-1)!
  const other = fillerSessionIds[1] ?? fillerSessionIds[0]!
  const epoch = tagFor('retired-pressure')
  const row = addRow(ctx, {
    family: 'outline',
    operation: 'tip fork under unrelated retired-history backlog',
    variant: 'large chat tip',
    context: {
      fixture:
        'synthetic retired copy of original history, prepared only while this disposable arm is stopped',
      requestedRetiredRows: largeItems,
      unrelatedSessionId: unrelated,
      concurrent: 'other-chat send started with the fork',
      diskPeakResolutionMs: 50
    },
    endToEndOnly:
      'local validation and provider copy are one host span; first tail read is separate'
  })
  const file = chatDatabasePath(ctx.launch.userDataDir)
  if (!file) {
    row.skipped = 'no chat SQLite database for retired backlog observation'
    return
  }
  await sampled(ctx, row, 1, async () => {
    let parked: string | null = null
    try {
      let prepared: RetiredHistory | undefined
      await waitForIdle(page(ctx), largeSessionId)
      await ctx.relaunch((dir) => {
        const backup = path.join(
          path.dirname(dir),
          `before-fork-pressure-${ctx.arm.name}-${Date.now()}`
        )
        renameSync(dir, backup)
        parked = backup
        copyProfile(backup, dir)
        prepared = prepareRetiredHistory(file, largeSessionId, unrelated, epoch, largeItems)
      })
      const backlog = retiredHistory(file, unrelated)
      row.context = {
        ...row.context,
        observedDatabase: path.basename(file),
        preparedRetiredRows: prepared!.rows,
        preparedRetiredPayloadBytes: prepared!.payloadBytes,
        observedRetiredRowsBeforeFork: backlog.rows,
        observedRetiredPayloadBytesBeforeFork: backlog.payloadBytes
      }
      if (backlog.rows === 0) {
        throw new Error('retired backlog drained before the fork; pressure scenario not exercised')
      }
      const [tip] = (await messageItemIds(page(ctx), largeSessionId, 'assistant', 1)).slice(-1)
      if (!tip) {
        throw new Error('large chat has no assistant tip to fork')
      }
      const before = storageBytes(ctx.launch.userDataDir)
      const stopPressure = samplePressure(ctx.launch.app, ctx.launch.userDataDir, 50)
      let pressure
      let sample
      try {
        sample = await measured(ctx, async (startedAt) => {
          const atRequest = retiredHistory(file, unrelated)
          if (atRequest.rows === 0) {
            throw new Error('retired backlog drained before fork dispatch; pressure not exercised')
          }
          const [fork, competing] = await Promise.all([
            (async () => {
              const created = await createChat(page(ctx), ctx.arm, workspace.worktreeIds[0], {
                sessionId: largeSessionId,
                throughItemId: tip
              })
              const remaining = retiredHistory(file, unrelated)
              const tail = await history(page(ctx), created.sessionId, 'tail', 40)
              if (tail.page.items.length === 0) {
                throw new Error('fork returned an empty persisted tail')
              }
              return { created, remaining, tail, endAt: await rendererNow(page(ctx)) }
            })(),
            competingSend(ctx, other)
          ])
          return {
            hostMs: fork.created.hostMs,
            e2eMs: fork.endAt - startedAt,
            extra: {
              forkTailReadMs: fork.tail.hostMs,
              forkTailItems: fork.tail.page.items.length,
              competingHostMs: competing.hostMs,
              competingDurableMs: competing.durableMs,
              retiredRowsAtForkRequest: atRequest.rows,
              retiredPayloadBytesAtForkRequest: atRequest.payloadBytes,
              retiredRowsAtForkCompletion: fork.remaining.rows,
              retiredPayloadBytesAtForkCompletion: fork.remaining.payloadBytes,
              completedBeforeCleanupFinished: Number(fork.remaining.rows > 0)
            }
          }
        })
      } finally {
        pressure = await stopPressure()
      }
      const after = storageBytes(ctx.launch.userDataDir)
      return {
        ...sample,
        extra: {
          ...sample.extra,
          peakWalBytes: Math.max(before.wal, after.wal, pressure.peakWalBytes),
          peakTotalBytes: Math.max(before.total, after.total, pressure.peakTotalBytes),
          walGrowthBytes: after.wal - before.wal,
          fileGrowthBytes: after.total - before.total
        }
      }
    } finally {
      const backup = parked
      if (backup) {
        await ctx.relaunch((dir) => {
          const evidence = path.join(
            path.dirname(dir),
            `after-fork-pressure-${ctx.arm.name}-${Date.now()}`
          )
          if (existsSync(dir)) {
            renameSync(dir, evidence)
          }
          renameSync(backup, dir)
          row.context = {
            ...row.context,
            pressureProfile: evidence,
            subsequentFamilies: 'original untouched profile restored after pressure case'
          }
        })
      }
    }
  })
}
