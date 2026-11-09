import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))

import { cloudSshHostAlias, renderSshHostBlock, upsertSshHostBlock } from './cloud-ssh'

const block = (alias: string, wakeUrl = 'https://cp/v1/ssh-wake/sbx_1') =>
  renderSshHostBlock({
    alias,
    identityFile: '/u/My Data/cloud-ssh/id_ed25519',
    knownHostsFile: '/u/My Data/cloud-ssh/known_hosts',
    nodeBinary: '/Applications/Orca.app/Contents/MacOS/Orca',
    proxyScript: '/u/My Data/cloud-ssh/orca-cloud-ssh-proxy.cjs',
    wakeUrl,
    secretFile: '/u/My Data/cloud-ssh/sbx_1.secret'
  })

describe('cloud ssh config', () => {
  it('derives a safe host alias', () => {
    expect(cloudSshHostAlias('Fix login bug!', 'sbx_0123456789abcdef01234567')).toBe(
      'orca-cloud-fix-login-bug'
    )
    expect(cloudSshHostAlias(undefined, 'sbx_0123456789abcdef01234567')).toBe('orca-cloud-01234567')
  })

  it('quotes paths with spaces and runs the proxy with the app runtime', () => {
    const text = block('orca-cloud-a')
    expect(text).toContain('IdentityFile "/u/My Data/cloud-ssh/id_ed25519"')
    expect(text).toContain(
      'ProxyCommand env ELECTRON_RUN_AS_NODE=1 "/Applications/Orca.app/Contents/MacOS/Orca"'
    )
    expect(text).toContain('IdentitiesOnly yes')
  })

  it('replaces only the same host block', () => {
    let config = upsertSshHostBlock('', 'orca-cloud-a', block('orca-cloud-a'))
    config = upsertSshHostBlock(
      config,
      'orca-cloud-b',
      block('orca-cloud-b', 'https://cp/v1/ssh-wake/sbx_b')
    )
    config = upsertSshHostBlock(
      config,
      'orca-cloud-a',
      block('orca-cloud-a', 'https://cp/v1/ssh-wake/sbx_2')
    )
    expect(config.match(/^Host /gm)).toHaveLength(2)
    expect(config).toContain('sbx_2')
    expect(config).not.toContain('ssh-wake/sbx_1 ')
    expect(config).toContain('Host orca-cloud-b')
  })
})
