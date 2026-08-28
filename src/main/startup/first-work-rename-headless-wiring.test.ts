import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('first-work rename wiring', () => {
  const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

  it('arms the rename before the serve early return so headless serve keeps it', () => {
    const appReadyIndex = source.indexOf('app.whenReady().then(async () => {')
    const renameIndex = source.indexOf(
      'maybeAutoRenameBranchOnFirstWorkFromHook({ paneKey, tabId, worktreeId, payload, isReplay })',
      appReadyIndex
    )
    const serveIndex = source.indexOf('if (serveOptions) {', appReadyIndex)

    expect(appReadyIndex).toBeGreaterThanOrEqual(0)
    expect(renameIndex).toBeGreaterThan(appReadyIndex)
    expect(serveIndex).toBeGreaterThan(renameIndex)
  })

  it('subscribes through the additive tap, not the single-slot main-window fanout', () => {
    const windowListenerIndex = source.indexOf('agentHookServer.setListener(\n')
    const windowListenerEndIndex = source.indexOf(
      'agentHookServer.setPaneStatusClearListener((clear)',
      windowListenerIndex
    )
    const windowListener = source.slice(windowListenerIndex, windowListenerEndIndex)

    expect(windowListenerIndex).toBeGreaterThanOrEqual(0)
    expect(windowListenerEndIndex).toBeGreaterThan(windowListenerIndex)
    expect(windowListener).not.toContain('maybeAutoRenameBranchOnFirstWorkFromHook')
    expect(source).toContain('agentHookServer.subscribeEnrichedStatus(')
  })

  it('keeps the fanout gates that skip session-only refreshes and restored rows', () => {
    const appReadyIndex = source.indexOf('app.whenReady().then(async () => {')
    const renameIndex = source.indexOf(
      'maybeAutoRenameBranchOnFirstWorkFromHook({ paneKey, tabId, worktreeId, payload, isReplay })',
      appReadyIndex
    )
    const subscribeIndex = source.lastIndexOf(
      'agentHookServer.subscribeEnrichedStatus(',
      renameIndex
    )
    const subscription = source.slice(subscribeIndex, renameIndex)

    expect(subscribeIndex).toBeGreaterThanOrEqual(0)
    expect(subscription).toContain('if (providerSessionOnly || restoredUnconfirmed) {')
  })
})
