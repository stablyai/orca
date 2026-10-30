import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../shared/wsl-host-internal-gate'

type Handler = (event: unknown, request?: unknown) => unknown

const handlers = vi.hoisted(() => new Map<string, Handler>())
vi.mock('electron', () => ({
  app: { getPath: () => '/user-data' },
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
  }
}))
const conversion = vi.hoisted(() => ({
  startWslDriveUncConversion: vi.fn(async () => ({ outcome: 'refused', blockers: [] }))
}))
vi.mock('../wsl/wsl-drive-unc-conversion-run', () => conversion)
const startup = vi.hoisted(() => ({
  lastWslDriveUncConversionOutcomes: vi.fn(() => [{ migrationId: 'conv-1', outcome: 'converted' }])
}))
vi.mock('../wsl/wsl-drive-unc-conversion-startup', () => startup)
vi.mock('../orca-profiles/profile-index-store', () => ({
  getOrcaProfileListState: () => ({ activeProfileId: 'profile-1' })
}))

import { registerWslDriveUncConversionHandlers } from './wsl-drive-unc-conversion-handlers'

const invoke = (channel: string, request?: unknown) => handlers.get(channel)?.({}, request)
const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

beforeEach(() => {
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  setPlatform('win32')
  conversion.startWslDriveUncConversion.mockClear()
  startup.lastWslDriveUncConversionOutcomes.mockClear()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The run is mocked; the handler only builds deps from these.
  registerWslDriveUncConversionHandlers({} as never, {} as never)
})
afterEach(() => {
  vi.unstubAllEnvs()
  setPlatform(originalPlatform)
})

describe('WSL drive UNC conversion IPC', () => {
  it('refuses with the gate closed, before reading anything', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    await expect(
      invoke('wslDriveUnc:convert', { distro: 'Ubuntu', repoIds: ['repo-a'] })
    ).rejects.toThrow('wsl_drive_unc_unavailable')
    expect(await invoke('wslDriveUnc:lastOutcomes')).toEqual([])
    expect(conversion.startWslDriveUncConversion).not.toHaveBeenCalled()
    expect(startup.lastWslDriveUncConversionOutcomes).not.toHaveBeenCalled()
  })

  it("refuses a conversion off Windows, but still reports startup's outcomes", async () => {
    setPlatform('darwin')
    await expect(
      invoke('wslDriveUnc:convert', { distro: 'Ubuntu', repoIds: ['repo-a'] })
    ).rejects.toThrow('wsl_drive_unc_unavailable')
    expect(conversion.startWslDriveUncConversion).not.toHaveBeenCalled()
    expect(await invoke('wslDriveUnc:lastOutcomes')).toEqual([
      { migrationId: 'conv-1', outcome: 'converted' }
    ])
  })

  it("converts the parsed request for the active profile, and reports startup's outcomes", async () => {
    await invoke('wslDriveUnc:convert', { distro: 'Ubuntu', repoIds: ['repo-a'], extra: true })
    expect(conversion.startWslDriveUncConversion).toHaveBeenCalledWith(
      expect.objectContaining({ userDataPath: '/user-data', profileId: 'profile-1' }),
      { distro: 'Ubuntu', repoIds: ['repo-a'], folderWorkspaceIds: [] }
    )
    expect(await invoke('wslDriveUnc:lastOutcomes')).toEqual([
      { migrationId: 'conv-1', outcome: 'converted' }
    ])
  })

  it.each([
    ['no distro', { repoIds: ['repo-a'] }],
    ['an empty id', { distro: 'Ubuntu', repoIds: [''] }],
    ['folder ids that are not a list', { distro: 'Ubuntu', repoIds: [], folderWorkspaceIds: 'f1' }]
  ])('rejects a request with %s', async (_case, request) => {
    await expect(invoke('wslDriveUnc:convert', request)).rejects.toThrow(
      'wsl_drive_unc_invalid_args'
    )
    expect(conversion.startWslDriveUncConversion).not.toHaveBeenCalled()
  })
})
