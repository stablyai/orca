import { describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, () => unknown>())
const retrySharedControl = vi.hoisted(() => vi.fn())
const retrySsh = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: () => unknown) => handlers.set(channel, handler)
  }
}))
vi.mock('./runtime-environment-request-connections', () => ({
  retryRemoteRuntimeSharedControlConnectionsNow: retrySharedControl
}))
vi.mock('../ssh/ssh-host-sleep-reconnect', () => ({
  retrySshConnectionsAfterNetworkReturn: retrySsh
}))

import { registerRuntimeEnvironmentRecoveryHandler } from './runtime-environment-recovery-handler'

describe('runtimeEnvironments:retryConnectionsNow', () => {
  it('retries SSH transports as well as shared control when the window reports the network back', () => {
    registerRuntimeEnvironmentRecoveryHandler()
    handlers.get('runtimeEnvironments:retryConnectionsNow')?.()
    expect(retrySharedControl).toHaveBeenCalledTimes(1)
    expect(retrySsh).toHaveBeenCalledTimes(1)
  })
})
