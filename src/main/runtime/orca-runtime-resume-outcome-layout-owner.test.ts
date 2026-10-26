// Only main waking a sleeping pane substitutes for window restore and records agent resume outcome.
import { describe, expect, it, vi } from 'vitest'
import type { PaneResumeOutcome } from '../../shared/workspace-layout/workspace-layout-published'
import { setupLayoutOwnerRuntime, WORKTREE_ID } from './orca-runtime-layout-owner-start-fixture'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const RESUME = {
  launchAgent: 'claude' as const,
  resumeProviderSession: { key: 'session_id' as const, id: 'provider-session-1' }
}

async function resumedPaneOutcome(opts: { resumesSleepingRecord?: true }) {
  const { runtime, spawn } = setupLayoutOwnerRuntime()
  spawn.mockImplementation(
    async (args: { onResumeOutcome?: (ptyId: string, outcome: PaneResumeOutcome) => void }) => {
      args.onResumeOutcome?.('pty-1', 'restored')
      return { id: 'pty-1' }
    }
  )
  await runtime.createTerminal(`id:${WORKTREE_ID}`, { ...RESUME, ...opts })
  const { tabId, leafId } = spawn.mock.calls[0]![0]
  return runtime.resumeOutcomeOf(`${tabId}:${leafId}`)
}

describe("main's start records a pane's resume outcome (layout-owner build)", () => {
  it("records it for a wake of the pane's sleeping record", async () => {
    expect(await resumedPaneOutcome({ resumesSleepingRecord: true })).toBe('restored')
  })

  it('records nothing for a resume another client asked for (Session History, a phone)', async () => {
    expect(await resumedPaneOutcome({})).toBeNull()
  })
})
