import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { ManagedDataAccountService } from './service'

const selected = {
  XDG_DATA_HOME: join(tmpdir(), 'managed-original', 'data'),
  XDG_STATE_HOME: join(tmpdir(), 'managed-original', 'state'),
  OPENCODE_AUTH_CONTENT: '',
  OPENCODE_DB: 'opencode.db'
}

function managedContext(
  service: ManagedDataAccountService,
  inline: string,
  profile = selected
): Record<string, string> {
  const env: Record<string, string> = {
    XDG_DATA_HOME: join(tmpdir(), 'system-original', 'data'),
    OPENCODE_AUTH_CONTENT: inline,
    OPENCODE_DB: 'system.db'
  }
  service.captureOriginalEnvironment(env, profile)
  return {
    ...env,
    ...profile,
    ORCA_DATA_ACCOUNT_DATA_HOME: profile.XDG_DATA_HOME,
    ORCA_DATA_ACCOUNT_STATE_HOME: profile.XDG_STATE_HOME,
    ORCA_DATA_ACCOUNT_PROVIDER: 'opencode'
  }
}

describe('host-private managed account originals', () => {
  it('does not resolve a reference attached to a different otherwise valid profile', () => {
    const service = new ManagedDataAccountService('private-original-root')
    const captured = managedContext(service, 'private-baseline')
    const foreign = managedContext(service, 'other-baseline', {
      ...selected,
      XDG_DATA_HOME: join(tmpdir(), 'different-profile', 'data'),
      XDG_STATE_HOME: join(tmpdir(), 'different-profile', 'state')
    })
    foreign.ORCA_DATA_ACCOUNT_ORIGINAL_ENV = captured.ORCA_DATA_ACCOUNT_ORIGINAL_ENV
    service.restoreOriginalEnvironment(foreign)
    expect(foreign.OPENCODE_AUTH_CONTENT).toBeUndefined()
  })

  it('does not resolve private references after service restart or explicit disposal', () => {
    const service = new ManagedDataAccountService('private-original-root')
    const captured = managedContext(service, 'private-baseline')
    const restarted = new ManagedDataAccountService('private-original-root')
    const foreign = { ...captured }
    restarted.restoreOriginalEnvironment(foreign)
    expect(foreign.OPENCODE_AUTH_CONTENT).toBeUndefined()
    service.clearInlineAuthBaselines()
    service.restoreOriginalEnvironment(captured)
    expect(captured.OPENCODE_AUTH_CONTENT).toBeUndefined()
  })
})
