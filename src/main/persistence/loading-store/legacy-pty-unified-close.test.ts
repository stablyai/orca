import { afterEach, expect, it, vi } from 'vitest'
import * as fence from '../moving-wsl-projects/wsl-move-scope-guard'
import { restoreFixture, tabId, workspace } from './legacy-pty-restore-test-fixture'
import { TerminalIdentityHandoff } from '../../pty/terminal-identity-handoff'

vi.mock('../moving-wsl-projects/wsl-move-scope-guard', async (original) => ({
  ...(await original<typeof fence>())
}))
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('keeps a selected owner through frozen and foreign unified removals, then retires the accepted local removal', async () => {
  const f = await restoreFixture()
  const restored = await f.start()
  const prior = structuredClone(f.store.getWorkspaceSession())
  const hasFrozen = vi.spyOn(fence, 'hasWslMoveFrozenSessions').mockReturnValue(true)
  const frozen = vi
    .spyOn(fence, 'isWslMoveWorkspaceSessionFrozen')
    .mockImplementation((id) => id === workspace)
  f.store.patchWorkspaceSession({ unifiedTabs: { [workspace]: [] } })
  expect(f.alive.has(restored.result.id)).toBe(true)
  expect(
    f.store.getWorkspaceSession().unifiedTabs?.[workspace]?.some((tab) => tab.entityId === tabId)
  ).toBe(true)
  hasFrozen.mockRestore()
  frozen.mockRestore()
  f.store.setWorkspaceSession(prior, 'ssh:another')
  f.store.patchWorkspaceSession({ unifiedTabs: { [workspace]: [] } }, 'ssh:another')
  expect(f.alive.has(restored.result.id)).toBe(true)
  expect(f.provider.killFenced).not.toHaveBeenCalled()
  f.store.patchWorkspaceSession({ unifiedTabs: { [workspace]: [] } })
  await vi.waitFor(() => expect(f.alive.has(restored.result.id)).toBe(false))
})

it('retires a tombstone-pruned owner outside the supplied unified slice with no identity handoff scan', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-09T12:00:00.000Z'))
  const f = await restoreFixture()
  const restored = await f.start()
  const prior = f.store.getWorkspaceSession()
  prior.closedTerminalTabTombstonesByTabId = {
    [tabId]: { closedAt: 1794225600000, worktreeId: workspace, reason: 'user' }
  }
  const visits = vi.spyOn(TerminalIdentityHandoff.prototype, 'observe')
  f.store.patchWorkspaceSession({ unifiedTabs: { 'other-workspace': [] } })
  await vi.waitFor(() => expect(f.alive.has(restored.result.id)).toBe(false))
  expect(f.store.getWorkspaceSession().terminalLayoutsByTabId[tabId]).toBeUndefined()
  expect(visits).not.toHaveBeenCalled()
})
