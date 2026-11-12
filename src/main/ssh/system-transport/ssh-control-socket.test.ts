import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SshTarget } from '../../../shared/ssh-types'

const { lstatSyncMock, mkdirSyncMock, tmpdirMock } = vi.hoisted(() => ({
  lstatSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  tmpdirMock: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    lstatSync: lstatSyncMock,
    mkdirSync: mkdirSyncMock
  }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    tmpdir: tmpdirMock
  }
})

import { getControlSocketPath, type SystemSshResolvedConfig } from './ssh-control-socket'

const CURRENT_UID = process.getuid?.() ?? 501

function createTarget(overrides?: Partial<SshTarget>): SshTarget {
  return {
    id: 'target-1',
    label: 'Test Server',
    configHost: 'devpod',
    host: '10.0.0.5',
    port: 22,
    username: 'deploy',
    ...overrides
  }
}

function createResolved(overrides?: Partial<SystemSshResolvedConfig>): SystemSshResolvedConfig {
  return {
    hostname: '10.0.0.5',
    port: 22,
    user: 'deploy',
    identityFile: ['/Users/me/.ssh/id_ed25519'],
    forwardAgent: false,
    identitiesOnly: true,
    proxyUseFdpass: true,
    controlMaster: 'no',
    controlPersist: 'no',
    ...overrides
  }
}

describe.skipIf(process.platform === 'win32')('getControlSocketPath', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('XDG_RUNTIME_DIR', '')
    tmpdirMock.mockReset()
    tmpdirMock.mockReturnValue('/tmp')
    mkdirSyncMock.mockReset()
    lstatSyncMock.mockReset()
    lstatSyncMock.mockReturnValue({
      isDirectory: () => true,
      uid: CURRENT_UID,
      mode: 0o40700
    })
  })

  it('uses a separate socket for GSSAPI-only authentication', () => {
    const ordinary = getControlSocketPath(createTarget(), createResolved())
    const gssapiOnly = getControlSocketPath(createTarget(), createResolved(), true)

    expect(gssapiOnly).not.toBe(ordinary)
  })

  it('changes the path when a config-backed target resolves to a different host', () => {
    const before = getControlSocketPath(createTarget({ host: '10.0.0.5' }), createResolved())
    const after = getControlSocketPath(
      createTarget({ host: '10.0.0.9' }),
      createResolved({ hostname: '10.0.0.9' })
    )

    expect(after).not.toBe(before)
  })

  it('changes the path when fresh ssh config resolution changes the route', () => {
    const before = getControlSocketPath(
      createTarget(),
      createResolved({ proxyCommand: 'ssh -W %h:%p old-bastion' })
    )
    const after = getControlSocketPath(
      createTarget(),
      createResolved({ proxyCommand: 'ssh -W %h:%p new-bastion' })
    )

    expect(after).not.toBe(before)
  })
})
