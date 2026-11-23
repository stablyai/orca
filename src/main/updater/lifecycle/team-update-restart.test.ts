import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { TeamUpdateRestart } from '../../../shared/updater/update-status-types'
import { TeamUpdateRestartController } from './team-update-restart'

it('preserves the deadline and allows only one retry in a new launch for the same verified release', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-team-restart-'))
  const controllers: TeamUpdateRestartController[] = []
  const notices: TeamUpdateRestart[] = []
  const launch = () => {
    const controller = new TeamUpdateRestartController({
      scope: () => ({ file: join(directory, 'update.json'), accountId: 'account' }),
      deadlineHours: () => 24,
      hasWorkingAgents: () => false,
      publish: (_version, status) => notices.push(status),
      install: () => {
        throw new Error('The deadline is still in the future')
      }
    })
    controllers.push(controller)
    return controller
  }
  try {
    const first = launch()
    await first.verified('2.0.0', '1.0.0')
    const deadlineAt = notices.at(-1)?.deadlineAt
    await first.snooze()
    expect(notices.at(-1)).toEqual({ phase: 'snoozed', deadlineAt })
    expect(await first.recordAttempt('2.0.0', true)).toBe(true)
    expect(await first.recordAttempt('2.0.0', true)).toBe(false)
    first.cancel()

    const retry = launch()
    await retry.verified('2.0.0', '1.0.0')
    expect(notices.at(-1)).toEqual({ phase: 'snoozed', deadlineAt })
    expect(await retry.recordAttempt('2.0.0', true)).toBe(true)
    retry.cancel()

    const exhausted = launch()
    await exhausted.verified('2.0.0', '1.0.0')
    expect(notices.at(-1)).toEqual({ phase: 'manual', deadlineAt })
    expect(await exhausted.recordAttempt('2.0.0', true)).toBe(false)
  } finally {
    for (const controller of controllers) {
      controller.cancel()
    }
    await rm(directory, { recursive: true, force: true })
  }
})
