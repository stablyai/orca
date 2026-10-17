import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'

const fakes = vi.hoisted(() => ({
  host: { publish: () => {}, removeAccount: vi.fn(async () => {}) },
  removeClaudeAccountFolder: vi.fn(async () => {})
}))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/data/orca' })
}))
vi.mock('./claude-profile-router', () => ({
  ClaudeProfileRouter: function ClaudeProfileRouter() {
    return fakes.host
  }
}))
vi.mock('./claude-profile-installed-router', () => ({
  installClaudeProfileRouter: () => {},
  installClaudeWslProfileRouter: () => {}
}))
vi.mock('./claude-profile-account-route', () => ({
  removeClaudeAccountFolder: fakes.removeClaudeAccountFolder
}))

import { ClaudeRuntimeAuthService } from './runtime-auth-service'

function service(): ClaudeRuntimeAuthService {
  const settings = getDefaultSettings('/home/user')
  return new ClaudeRuntimeAuthService({ getSettings: () => settings })
}

describe('ClaudeRuntimeAuthService for kept agents', () => {
  it("points kept panes away before a host account's folder is removed", async () => {
    const auth = service()
    await auth.removeAccountFolder('a', { runtime: 'host' })
    expect(fakes.removeClaudeAccountFolder).toHaveBeenCalledWith(fakes.host, 'a')
    expect(fakes.host.removeAccount).not.toHaveBeenCalled()
  })
})
