import { describe, expect, it } from 'vitest'
import { resolveMobileAgentHistoryHostScope } from './agent-history-host-scope'

const SUPPORTED = ['aiVault.v1', 'aiVault.host-scope.v1']

describe('resolveMobileAgentHistoryHostScope', () => {
  it('requests the SSH worktree host when the host advertises host scope', () => {
    expect(resolveMobileAgentHistoryHostScope({ hostId: 'ssh:builder' }, SUPPORTED)).toBe(
      'ssh:builder'
    )
  })

  it('sends nothing to a host that does not advertise host scope', () => {
    expect(resolveMobileAgentHistoryHostScope({ hostId: 'ssh:builder' }, ['aiVault.v1'])).toBe(
      undefined
    )
    expect(resolveMobileAgentHistoryHostScope({ hostId: 'ssh:builder' }, undefined)).toBe(undefined)
  })

  it('keeps the local scan for local, runtime and unknown workspaces', () => {
    expect(resolveMobileAgentHistoryHostScope({ hostId: 'local' }, SUPPORTED)).toBe(undefined)
    expect(resolveMobileAgentHistoryHostScope({ hostId: 'runtime:devbox' }, SUPPORTED)).toBe(
      undefined
    )
    expect(resolveMobileAgentHistoryHostScope({}, SUPPORTED)).toBe(undefined)
    expect(resolveMobileAgentHistoryHostScope(null, SUPPORTED)).toBe(undefined)
  })
})
