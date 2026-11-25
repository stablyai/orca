import type { BrowserScreencastFrameBudget } from './browser-screencast-stream-types'

// Respect the smallest viewer budget; throttle with the pacer to retain static pages' final frames.
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
