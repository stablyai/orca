import { describe, expect, it, vi } from 'vitest'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn(),
    removeListener: vi.fn()
  }
}))

import {
  configurePairedRuntimeBrowserClientHostsForOrcaProfile,
  startPairedRuntimeBrowserClientHost
} from './paired-runtime-browser-client-host-runtime'

describe('paired runtime browser client host runtime', () => {
  it('returns a rejected promise when pairing resolution fails', async () => {
    configurePairedRuntimeBrowserClientHostsForOrcaProfile({ orcaProfileId: 'profile-a' })
    const environment = {
      id: 'environment-a',
      name: 'Environment A',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      runtimeId: null,
      endpoints: [],
      preferredEndpointId: 'missing'
    } as KnownRuntimeEnvironment

    const starting = startPairedRuntimeBrowserClientHost({
      environment,
      authorityRuntimeId: 'runtime-a'
    })

    expect(starting).toBeInstanceOf(Promise)
    await expect(starting).rejects.toThrow('Environment Environment A has no access endpoints')
  })
})
