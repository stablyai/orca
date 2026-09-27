import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('OrcaRuntimeService remote open-url binding', () => {
  // Why: browser commands reach the runtime through an explicit name list; a method missing from
  // it still type-checks but is undefined at runtime, which silently broke `orca open-url` over SSH.
  it('exposes requestDesktopOpenUrlForSshTarget on the runtime', () => {
    const runtime = new OrcaRuntimeService()
    expect(typeof runtime.requestDesktopOpenUrlForSshTarget).toBe('function')
  })
})
