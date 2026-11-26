// 4a maintenance rows on debt the run creates and observes: large completed rows written then rewound on a disposable seeded
// chat while an outside read-only reader holds a snapshot, its release, and freed pages watched back down, each while another
// chat sends. Page, free-list and WAL state come from read-only SQLite reads; nothing asks the app for timing.
import path from 'node:path'
import type { Sample } from './native-chat-4a-report'
import { addRow, page, tagFor, type RunContext } from './native-chat-4a-run-context'
import {
  history,
  messageItemIds,
  mutate,
  openChatTab,
  send,
  waitForControls,
  waitForDurable,
  waitForIdle
} from './native-chat-4a-session'
import { chatDatabasePath, holdReader, pageState } from './native-chat-4a-sqlite-observer'
import { debtPrompt, replyPrompt } from './native-chat-4a-workloads'

// JOURNAL_WAL_BACKPRESSURE_FRAMES on the candidate (journal-checkpoint-owner.ts): writes wait above this many WAL frames.
const BACKPRESSURE_FRAMES = 32_768
const RELEASE_WATCH_MS = 30_000
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Sends to `other` until `done()`, each sample its host span plus the store's WAL bytes and free pages right after. */
async function sendsUntil(
  ctx: RunContext,
  other: string,
  file: string,
  done: () => boolean,
  everyMs: number
): Promise<Sample[]> {
  const started = Date.now()
  const samples: Sample[] = []
  while (!done()) {
    const answer = await send(page(ctx), ctx.arm, other, replyPrompt(tagFor('maint')))
    const state = pageState(file)
    samples.push({
      hostMs: answer.hostMs,
      extra: {
        sinceStartMs: Date.now() - started,
        walBytes: state.walBytes,
        freelistPages: state.freelistPages
      }
    })
    await sleep(everyMs)
  }
  await waitForIdle(page(ctx), other)
  return samples
}

const peak = (samples: Sample[], key: string): number =>
  Math.max(0, ...samples.map((sample) => sample.extra?.[key] ?? 0))

export async function maintenanceDebtRows(ctx: RunContext): Promise<void> {
  const { fillerSessionIds, workspace } = ctx.manifest
  const { debtTools, debtToolBytes, holdMs, reclaimWaitMs } = ctx.workload.maintenance
  // The neutral chat, which later families only use as an active tab; its debt turn is rewound away again.
  const debt = fillerSessionIds[2] ?? fillerSessionIds.at(-1)!
  const other = fillerSessionIds[1] ?? fillerSessionIds[0]!
  const file = chatDatabasePath(ctx.launch.userDataDir)
  const variant = `${debtTools} × ${(debtToolBytes / 1024 / 1024).toFixed(2)} MiB completed rows`
  const context = {
    observedDatabase: file ? path.basename(file) : 'none',
    holdMs,
    concurrent: 'small sends to another chat'
  }
  const row = (operation: string, extra: Record<string, number | string> = {}) =>
    addRow(ctx, { family: 'maintenance', operation, variant, context: { ...context, ...extra } })
  const removal = row('large-row removal (rewind) under a held outside reader', {
    endPoints: 'rewind request → host answer; includes any WAL admission wait'
  })
  const hold = row('other-chat sends while an outside reader holds a snapshot', {
    backpressureFrames: BACKPRESSURE_FRAMES
  })
  const release = row('other-chat sends after the outside reader releases', {
    watchMs: RELEASE_WATCH_MS
  })
  const reclaim = row('other-chat sends while freed pages are reclaimed', {
    watchMs: reclaimWaitMs,
    reclaimOwner: 'periodic maintenance each minute, at most 1024 single-page units per run'
  })
  const retired = row('retired-epoch prune')
  const all = [removal, hold, release, reclaim, retired]
  if (!file) {
    for (const each of all) {
      each.skipped = 'no chat SQLite database found in the profile'
    }
    return
  }
  try {
    await openChatTab(page(ctx), workspace.worktreeIds[1], debt)
    await waitForControls(page(ctx))
    const baseline = pageState(file, true)
    const tag = tagFor('debt')
    await send(page(ctx), ctx.arm, debt, debtPrompt(ctx.workload, tag))
    await waitForDurable(page(ctx), debt, `4A-TAIL-${tag}`, 600_000, 250)
    await waitForIdle(page(ctx), debt, 600_000)
    const written = pageState(file)
    const [cutAt] = (await messageItemIds(page(ctx), debt, 'user', 1)).slice(-1)
    const epoch = (await history(page(ctx), debt, 'tail', 1)).page.epoch

    // The reader is released by a timer, whatever the app or the sends are doing.
    const releaseReader = holdReader(file)
    let releasedAt = Number.NaN
    const timer = setTimeout(() => {
      releaseReader()
      releasedAt = Date.now()
    }, holdMs)
    let removalHostMs = Number.NaN
    try {
      // Settled into a value so a refusal during the hold is never an unhandled rejection.
      const rewound = mutate(page(ctx), ctx.arm, 'agentSession.rewind', debt, {
        itemId: cutAt,
        expectedEpoch: epoch
      }).then(
        (answer) => ({ answer }),
        (error: unknown) => ({ error })
      )
      hold.samples.push(
        ...(await sendsUntil(ctx, other, file, () => !Number.isNaN(releasedAt), 250))
      )
      const outcome = await rewound
      if ('error' in outcome) {
        throw outcome.error
      }
      removalHostMs = outcome.answer.hostMs
    } finally {
      clearTimeout(timer)
      releaseReader()
      releasedAt = Number.isNaN(releasedAt) ? Date.now() : releasedAt
    }
    const peakWal = peak(hold.samples, 'walBytes')
    const walFrames = Math.max(0, Math.floor((peakWal - 32) / (baseline.pageSize + 24)))
    hold.context = {
      ...hold.context,
      peakWalBytes: peakWal,
      peakWalFrames: walFrames,
      reachedBackpressure: Number(walFrames >= BACKPRESSURE_FRAMES)
    }

    const atRelease = pageState(file)
    let shrunkAt = Number.NaN
    release.samples.push(
      ...(await sendsUntil(
        ctx,
        other,
        file,
        () => {
          if (Number.isNaN(shrunkAt) && pageState(file).walBytes < atRelease.walBytes) {
            shrunkAt = Date.now()
          }
          return !Number.isNaN(shrunkAt) || Date.now() - releasedAt > RELEASE_WATCH_MS
        },
        250
      ))
    )
    release.context = { ...release.context, walShrinkMs: shrunkAt - releasedAt }

    const removed = pageState(file, true)
    removal.samples.push({
      hostMs: removalHostMs,
      extra: {
        writtenBytes: (written.pageCount - baseline.pageCount) * baseline.pageSize,
        freedPages: removed.freelistPages - baseline.freelistPages
      }
    })

    const reclaimStarted = Date.now()
    let backAt = Number.NaN
    reclaim.samples.push(
      ...(await sendsUntil(
        ctx,
        other,
        file,
        () => {
          if (Number.isNaN(backAt) && pageState(file).freelistPages <= baseline.freelistPages) {
            backAt = Date.now()
          }
          return !Number.isNaN(backAt) || Date.now() - reclaimStarted > reclaimWaitMs
        },
        1_000
      ))
    )
    const end = pageState(file, true)
    reclaim.context = {
      ...reclaim.context,
      freelistBaseline: baseline.freelistPages,
      freelistAtStart: removed.freelistPages,
      freelistAtEnd: end.freelistPages,
      reclaimedPages: removed.freelistPages - end.freelistPages,
      backToBaselineMs: backAt - reclaimStarted
    }

    const retiredCounts = [baseline, removed, end].map((state) => state.retiredEpochRows)
    retired.context = { ...retired.context, retiredEpochRows: retiredCounts.join(' → ') }
    if (retiredCounts.every((count) => !count)) {
      retired.skipped =
        'missing evidence: no row under a retired epoch was observed; ordinary rewind/removal deletes rows in place, so retired-epoch pruning was not exercised'
    } else {
      retired.samples.push({
        extra: {
          retiredAtStart: removed.retiredEpochRows ?? 0,
          retiredAtEnd: end.retiredEpochRows ?? 0
        }
      })
    }
  } catch (error) {
    const reason = `failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300)
    for (const each of all.filter((entry) => entry.samples.length === 0 && !entry.skipped)) {
      each.skipped = reason
    }
    ctx.log(`maintenance debt rows: ${reason}`)
  }
}
