import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'

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

  it('returns a stable short private socket path for the same effective target', () => {
    const first = getControlSocketPath(createTarget(), createResolved())
    const second = getControlSocketPath(createTarget(), createResolved())

    expect(first).toBe(second)
    expect(first).toMatch(new RegExp(`/orca-ssh-${CURRENT_UID}/[0-9a-f]{16}$`))
    // Why: OpenSSH creates a temporary mux listener by appending a suffix first.
    expect(first!.length).toBeLessThanOrEqual(90)
    expect(mkdirSyncMock).toHaveBeenCalledWith(`/tmp/orca-ssh-${CURRENT_UID}`, {
      recursive: true,
      mode: 0o700
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

  it('uses XDG_RUNTIME_DIR before tmp when it is absolute and private', () => {
    vi.stubEnv('XDG_RUNTIME_DIR', '/run/user/501')

    const path = getControlSocketPath(createTarget(), createResolved())

    expect(path).toMatch(/^\/run\/user\/501\/orca-ssh\/[0-9a-f]{16}$/)
  })

  it('falls back to non-multiplexed SSH when the control directory is unsafe', () => {
    lstatSyncMock.mockReturnValue({
      isDirectory: () => false,
      uid: CURRENT_UID,
      mode: 0o40700
    })

    expect(getControlSocketPath(createTarget(), createResolved())).toBeNull()
  })
})
