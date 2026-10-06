import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { ANTIGRAVITY_WSL_ACCOUNTS_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: { fromId: () => null },
  webContents: { fromId: () => null },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() }
}))
afterEach(() => vi.restoreAllMocks())
it.each(['linux', 'darwin', 'win32'] as const)(
  'only advertises WSL native Accounts on Windows (%s)',
  (platform) => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    expect(
      runtime.getStatus().capabilities?.includes(ANTIGRAVITY_WSL_ACCOUNTS_RUNTIME_CAPABILITY)
    ).toBe(platform === 'win32')
  }
)
