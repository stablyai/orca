import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))

describe('managed skill startup recovery', () => {
  it('continues skill management after startup recovery fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const runtime = new OrcaRuntimeService(null, undefined, {
      skillTransactionRecovery: Promise.reject(new Error('transient-recovery-failure'))
    })

    await expect(runtime.listManagedSkillInstalls()).resolves.toEqual([])
  })
})
