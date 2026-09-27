import { describe, expect, it } from 'vitest'
import { orchestrationCompatibilityHostScopesEqual } from './orchestration-compatibility-host-scope'

describe('orchestration host scope identity', () => {
  it('ignores property insertion order for the same execution host', () => {
    expect(
      orchestrationCompatibilityHostScopesEqual(
        { kind: 'local', hostId: 'local' },
        { hostId: 'local', kind: 'local' }
      )
    ).toBe(true)
    expect(
      orchestrationCompatibilityHostScopesEqual(
        { kind: 'wsl', hostId: 'local', distro: 'Ubuntu' },
        { distro: 'Ubuntu', hostId: 'local', kind: 'wsl' }
      )
    ).toBe(true)
    expect(
      orchestrationCompatibilityHostScopesEqual(
        { kind: 'ssh', targetId: 'host-a' },
        { targetId: 'host-a', kind: 'ssh' }
      )
    ).toBe(true)
  })
  it('rejects different execution boundaries', () => {
    expect(
      orchestrationCompatibilityHostScopesEqual(
        { kind: 'local', hostId: 'local' },
        { kind: 'wsl', hostId: 'local', distro: 'Ubuntu' }
      )
    ).toBe(false)
    expect(
      orchestrationCompatibilityHostScopesEqual(
        { kind: 'wsl', hostId: 'local', distro: 'Ubuntu' },
        { kind: 'wsl', hostId: 'local', distro: 'Debian' }
      )
    ).toBe(false)
    expect(
      orchestrationCompatibilityHostScopesEqual(
        { kind: 'ssh', targetId: 'host-a' },
        { kind: 'ssh', targetId: 'host-b' }
      )
    ).toBe(false)
  })
})
