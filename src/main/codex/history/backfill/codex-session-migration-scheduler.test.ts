import { describe, expect, it, vi } from 'vitest'
import { createCodexSessionMigrationScheduler } from './codex-session-migration-scheduler'

type SchedulerArgs = Parameters<typeof createCodexSessionMigrationScheduler>[0]

function createScheduler(
  args: Partial<SchedulerArgs> = {}
): { scheduler: ReturnType<typeof createCodexSessionMigrationScheduler> } & Pick<
  SchedulerArgs,
  'startBackfill' | 'startIndexHeal'
> {
  const startBackfill = vi.fn().mockResolvedValue({})
  const startIndexHeal = vi.fn().mockResolvedValue({})
  return {
    scheduler: createCodexSessionMigrationScheduler({
      isEligible: () => true,
      isQuitting: () => false,
      resolveSystemCodexHomePathOverride: () => undefined,
      startBackfill,
      startIndexHeal,
      ...args
    }),
    startBackfill,
    startIndexHeal
  }
}

describe('createCodexSessionMigrationScheduler', () => {
  it('skips the backfill and index heal when the codex CLI is unavailable', async () => {
    const { scheduler, startBackfill, startIndexHeal } = createScheduler({
      isCodexCliAvailable: () => false
    })

    scheduler.requestRun()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(startBackfill).not.toHaveBeenCalled()
    expect(startIndexHeal).not.toHaveBeenCalled()
  })

  it('runs the backfill and index heal when the codex CLI is available', async () => {
    const { scheduler, startBackfill, startIndexHeal } = createScheduler({
      isCodexCliAvailable: () => true
    })

    scheduler.requestRun()
    expect(startBackfill).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(startIndexHeal).toHaveBeenCalledTimes(1))
  })
})
