import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcRenderer: { invoke: vi.fn(), on: vi.fn() } }))

import { getWslHostsApi } from './wsl-hosts-api'

describe('WSL hosts preload API', () => {
  it('is absent on Windows and under the e2e fake while the internal gate is closed', () => {
    expect(getWslHostsApi({}, 'win32')).toBeUndefined()
    expect(getWslHostsApi({ ORCA_INTERNAL_WSL_HOSTS: 'true' }, 'win32')).toBeUndefined()
    expect(getWslHostsApi({ ORCA_E2E_FAKE_WSL_HOSTS: '{}' }, 'darwin')).toBeUndefined()
  })

  it('is present behind the open gate only where WSL hosts can run', () => {
    expect(getWslHostsApi({ ORCA_INTERNAL_WSL_HOSTS: '1' }, 'win32')).toBeDefined()
    expect(
      getWslHostsApi({ ORCA_INTERNAL_WSL_HOSTS: '1', ORCA_E2E_FAKE_WSL_HOSTS: '{}' }, 'linux')
    ).toBeDefined()
    expect(getWslHostsApi({ ORCA_INTERNAL_WSL_HOSTS: '1' }, 'darwin')).toBeUndefined()
  })
})
