import { describe, expect, it, vi } from 'vitest'

vi.mock('./wsl-host-automation-enable', async (importOriginal) => ({
  ...(await importOriginal<typeof EnableModule>()),
  openWslHostAutomationApi: async () => async (_method: string, params: { id: string }) =>
    params.id === 'kept'
      ? { ok: true, result: { automation: { enabled: true, updatedAt: 1 } } }
      : { ok: false, error: { message: 'Automation not found.' } }
}))

import type * as EnableModule from './wsl-host-automation-enable'

const { readWslHostAutomationStates } = await import('./wsl-host-automation-disable')

describe('readWslHostAutomationStates', () => {
  it('leaves out one the host no longer has, so undo cannot read it as a paused choice', async () => {
    await expect(
      readWslHostAutomationStates('/u', 'wsl:Ubuntu', ['kept', 'gone'])
    ).resolves.toEqual({ kept: true })
  })
})
