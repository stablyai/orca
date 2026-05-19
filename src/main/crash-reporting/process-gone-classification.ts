export type ProcessGoneSource = 'renderer' | 'child'
export type ExpectedTeardownScope = 'none' | 'renderer-reload' | 'app-shutdown'

export function shouldRecordProcessGoneCrash({
  source,
  reason,
  expectedTeardown
}: {
  source: ProcessGoneSource
  reason: string
  expectedTeardown: ExpectedTeardownScope
}): boolean {
  // Why: Electron reports intentional reload/update/quit teardown as `killed`.
  // Real renderer OOMs and Chromium crashes should still reach crash reporting.
  if (reason !== 'killed') {
    return true
  }
  if (expectedTeardown === 'app-shutdown') {
    return false
  }
  return !(source === 'renderer' && expectedTeardown === 'renderer-reload')
}

export function shouldRecoverRendererAfterProcessGone({
  reason,
  expectedTeardown
}: {
  reason: string
  expectedTeardown: ExpectedTeardownScope
}): boolean {
  if (expectedTeardown === 'app-shutdown') {
    return false
  }
  return !(reason === 'killed' && expectedTeardown === 'renderer-reload')
}
