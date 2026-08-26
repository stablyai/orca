import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Codex session migration wiring', () => {
  const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

  it('forwards active launch tracking when a scheduled run finishes', () => {
    const schedulerStart = source.indexOf('codexSessionMigration = createCodexSessionMigrationScheduler({')
    const schedulerEnd = source.indexOf('\n  })', schedulerStart)

    expect(schedulerStart).toBeGreaterThanOrEqual(0)
    expect(schedulerEnd).toBeGreaterThan(schedulerStart)

    const schedulerWiring = source.slice(schedulerStart, schedulerEnd)
    expect(schedulerWiring).toContain('finishScheduledRun: (keepLaunchTracking) =>')
    expect(schedulerWiring).toContain(
      'finishHostSystemDefaultSessionMigrationPass(keepLaunchTracking)'
    )
    expect(schedulerWiring).not.toContain('finishScheduledRun: () =>')
  })
})
