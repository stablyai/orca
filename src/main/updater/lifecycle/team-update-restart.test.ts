import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { TeamUpdateRestart } from '../../../shared/updater/update-status-types'
import { TeamUpdateRestartController } from './team-update-restart'
import { TeamUpdateRestartRecordStore } from './team-update-restart-record'

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

it('keeps an overdue restart bound to its original profile through native handoff', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-team-restart-'))
  const original = { file: join(directory, 'original', 'update.json'), accountId: 'account' }
  const otherProfile = { file: join(directory, 'other', 'update.json'), accountId: 'account' }
  let scope = original
  const pendingInstalls: (() => boolean)[] = []
  const controller = new TeamUpdateRestartController({
    scope: () => scope,
    deadlineHours: () => 1,
    hasWorkingAgents: () => false,
    publish: () => {},
    install: (isCurrent) => pendingInstalls.push(isCurrent)
  })
  try {
    await new TeamUpdateRestartRecordStore(original.file).write({
      accountId: original.accountId,
      runningVersion: '1.0.0',
      version: '2.0.0',
      downloadedAt: 1,
      countdownStartedAt: 3_600_001,
      installAttempts: 0
    })
    await controller.verified('2.0.0', '1.0.0')
    expect(pendingInstalls[0]()).toBe(true)
    scope = otherProfile
    expect(pendingInstalls[0]()).toBe(false)
    controller.cancel()
    await controller.verified('2.0.0', '1.0.0')
    expect(pendingInstalls).toHaveLength(1)
    scope = original
    expect(pendingInstalls[0]()).toBe(false)
  } finally {
    controller.cancel()
    await rm(directory, { recursive: true, force: true })
  }
})
