import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: true } }))

describe('isUpdaterActive', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('keeps a packaged custom build off the upstream updater', async () => {
    vi.stubEnv('VITEST', '')
    const { isUpdaterActive } = await import('./fork-updater')
    expect(isUpdaterActive()).toBe(false)
  })
})
