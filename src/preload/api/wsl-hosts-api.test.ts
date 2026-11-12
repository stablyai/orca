import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
}))

import {
  formatWslHostsPolicyBlockedArgument,
  formatWslHostsServeOnlyArgument,
  WSL_HOSTS_INTERNAL_GATE_ENV
} from '../../shared/wsl-host-internal-gate'
import { getWslHostsApi } from './wsl-hosts-api'

describe('getWslHostsApi', () => {
  it('is present on Windows with no gate variable set', () => {
    expect(getWslHostsApi({}, 'win32', [])).toBeDefined()
  })

  it.each<NodeJS.Platform>(['darwin', 'linux'])('is absent on %s', (platform) => {
    expect(getWslHostsApi({}, platform, [])).toBeUndefined()
  })

  it('is absent on Windows when the launch turns the gate off', () => {
    expect(getWslHostsApi({ [WSL_HOSTS_INTERNAL_GATE_ENV]: '0' }, 'win32', [])).toBeUndefined()
  })

  it('is absent on Windows when the remote policy blocked the gate', () => {
    expect(getWslHostsApi({}, 'win32', [formatWslHostsPolicyBlockedArgument()])).toBeUndefined()
  })

  it('stays present behind a closed gate when main stamped serve-only', () => {
    const env = { [WSL_HOSTS_INTERNAL_GATE_ENV]: '0' }
    expect(getWslHostsApi(env, 'win32', [formatWslHostsServeOnlyArgument()])).toBeDefined()
  })
})
