import type { BrowserScreencastFrameBudget } from './browser-screencast-stream-types'

// Why: one CDP screencast feeds every subscriber of a page, so the shared budget has to
// satisfy the most constrained viewer. Size/quality go to the minimum because an
// over-budget frame is refused outright by the paired-runtime binary limit, while a
// roomier viewer only loses sharpness. everyNthFrame goes the other way: skipping
// captures can lose a static page's final frame, so the least-skipping value wins and
// minFrameIntervalMs (which retains the newest frame) carries the throttling.
export function mergeBrowserScreencastFrameBudgets(
  budgets: readonly BrowserScreencastFrameBudget[]
): BrowserScreencastFrameBudget | null {
  let merged: BrowserScreencastFrameBudget | null = null
  for (const budget of budgets) {
    merged = merged
      ? {
          quality: Math.min(merged.quality, budget.quality),
          maxWidth: Math.min(merged.maxWidth, budget.maxWidth),
          maxHeight: Math.min(merged.maxHeight, budget.maxHeight),
          everyNthFrame: Math.min(merged.everyNthFrame, budget.everyNthFrame),
          minFrameIntervalMs: Math.max(merged.minFrameIntervalMs, budget.minFrameIntervalMs)
        }
      : { ...budget }
  }
  return merged
}

export function browserScreencastFrameBudgetsEqual(
  a: BrowserScreencastFrameBudget,
  b: BrowserScreencastFrameBudget
): boolean {
  return (
    a.quality === b.quality &&
    a.maxWidth === b.maxWidth &&
    a.maxHeight === b.maxHeight &&
    a.everyNthFrame === b.everyNthFrame &&
    a.minFrameIntervalMs === b.minFrameIntervalMs
  )
}
