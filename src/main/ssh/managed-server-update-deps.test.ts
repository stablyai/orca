import { describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import { managedServerUpdateDeps } from './managed-server-update-deps'

vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getVersion: () => '1.4.300' })
}))
vi.mock('../managed-server/lifecycle/orcad-managed-runtime-context', () => ({
  requireManagedOrcadTargetStore: () => ({ updateTarget: vi.fn() })
}))

const target = (id: string): SshTarget => ({ id, label: id, host: id, port: 22, username: 'me' })

describe('remembering a managed-server update failure for this launch', () => {
  it('counts only an actual failure, and outlives the per-connect deps', () => {
    const deps = managedServerUpdateDeps('/tmp/user-data')
    expect(deps.failedThisLaunch(target('a'))).toBe(false)
    deps.recordUpdateFailure(target('a'), 'candidate rejected')
    expect(managedServerUpdateDeps('/tmp/user-data').failedThisLaunch(target('a'))).toBe(true)
    expect(deps.failedThisLaunch(target('b'))).toBe(false)
  })
})
