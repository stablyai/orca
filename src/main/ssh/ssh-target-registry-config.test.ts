import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshConnectionStore } from './ssh-connection-store'
import { ensureRegisteredSshConfigTarget, setSshTargetRegistryStore } from './ssh-target-registry'

const { resolveUserSshConfigHostMock } = vi.hoisted(() => ({
  resolveUserSshConfigHostMock: vi.fn()
}))

vi.mock('./ssh-config-host-picker', () => ({
  resolveUserSshConfigHost: resolveUserSshConfigHostMock
}))

describe('ensureRegisteredSshConfigTarget', () => {
  afterEach(() => {
    setSshTargetRegistryStore(null)
    vi.clearAllMocks()
  })

  it('adds one resolved SSH config alias', async () => {
    resolveUserSshConfigHostMock.mockResolvedValue({
      alias: 'devbox',
      hostname: 'dev.internal',
      port: 2222,
      username: 'notion',
      identityFiles: ['/secret/key'],
      identitiesOnly: true,
      forwardAgent: false,
      gssapiAuthentication: false,
      proxyCommand: 'proxy command',
      proxyUseFdpass: false
    })
    const target = {
      id: 'ssh-1',
      label: 'devbox',
      configHost: 'devbox',
      host: 'dev.internal',
      port: 2222,
      username: 'notion',
      proxyCommand: 'proxy command'
    }
    const store = {
      listTargets: vi.fn().mockReturnValue([]),
      addTarget: vi.fn().mockReturnValue(target)
    }
    setSshTargetRegistryStore(store as unknown as SshConnectionStore)

    await expect(ensureRegisteredSshConfigTarget('devbox')).resolves.toEqual({
      target,
      created: true
    })
    expect(store.addTarget).toHaveBeenCalledWith({
      label: 'devbox',
      configHost: 'devbox',
      host: 'dev.internal',
      port: 2222,
      username: 'notion',
      proxyCommand: 'proxy command'
    })
  })

  it('returns an existing alias without resolving or adding it again', async () => {
    const target = {
      id: 'ssh-1',
      label: 'DevBox',
      configHost: 'DevBox',
      host: 'dev.internal',
      port: 22,
      username: 'notion'
    }
    const store = {
      listTargets: vi.fn().mockReturnValue([target]),
      addTarget: vi.fn()
    }
    setSshTargetRegistryStore(store as unknown as SshConnectionStore)

    await expect(ensureRegisteredSshConfigTarget('devbox')).resolves.toEqual({
      target,
      created: false
    })
    expect(resolveUserSshConfigHostMock).not.toHaveBeenCalled()
    expect(store.addTarget).not.toHaveBeenCalled()
  })
})
