import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))

describe('managed skill startup recovery', () => {
  it('waits for startup recovery before reading local managed installs', async () => {
    let finishRecovery!: () => void
    const recovery = new Promise<void>((resolve) => {
      finishRecovery = resolve
    })
    const runtime = new OrcaRuntimeService(null, undefined, {
      skillTransactionRecovery: recovery
    })
    const listing = runtime.listManagedSkillInstalls()
    let settled = false
    void listing.finally(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)

    finishRecovery()
    await expect(listing).resolves.toEqual([])
  })
})
