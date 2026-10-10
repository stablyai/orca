import { afterEach, expect, it, vi } from 'vitest'
import { logOrcadActivationOutcome } from './orcad-activation-outcome-log'

afterEach(() => {
  vi.restoreAllMocks()
})

it('logs the code and reason of an update that was not activated', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await logOrcadActivationOutcome(
    'update to 0.2.0',
    async () => ({
      outcome: 'installed-not-activated',
      code: 'orcad_candidate_launch_failed',
      reason: 'The candidate failed while starting.'
    }),
    ['installed-and-activated']
  )
  expect(warn).toHaveBeenCalledWith(
    '[orcad] update to 0.2.0 installed-not-activated (orcad_candidate_launch_failed): The candidate failed while starting.'
  )
})

it('logs a run that threw, and stays quiet for one that went through', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await expect(
    logOrcadActivationOutcome('rollback to 0.1.0', () => Promise.reject(new Error('lost')), [])
  ).rejects.toThrow('lost')
  expect(warn).toHaveBeenCalledWith('[orcad] rollback to 0.1.0 failed: lost')
  warn.mockClear()
  await logOrcadActivationOutcome('rollback to 0.1.0', async () => ({ outcome: 'rolled-back' }), [
    'rolled-back'
  ])
  expect(warn).not.toHaveBeenCalled()
})
