import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const execOrcadRemote = vi.hoisted(() => vi.fn())
vi.mock('./orcad-remote-runtime-control', () => ({ execOrcadRemote }))
const resolveOrcadRemoteContext = vi.hoisted(() => vi.fn())
vi.mock('./orcad-remote-context', () => ({ resolveOrcadRemoteContext }))

import {
  orcadBoundPort,
  readManagedOrcadBoundPort,
  resolveManagedOrcadTunnelPort
} from './orcad-managed-bound-port'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'

function readinessLine(boundEndpoint: string | null): string {
  return `${JSON.stringify({ type: 'orca_server_ready', runtimeId: 'runtime-1', boundEndpoint })}\n`
}

function slot() {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exec is mocked; the connection is never used.
    conn: {} as SshConnection,
    host: getRemoteHostPlatform('linux-x64'),
    remoteInstallDir: '/home/deploy/.orca-orcad/1.0.0'
  }
}

describe('orcadBoundPort', () => {
  it('reads the port orcad actually bound', () => {
    expect(orcadBoundPort({ boundEndpoint: 'ws://127.0.0.1:58520' })).toBe(58_520)
  })

  it.each([null, 'not a url', 'ws://127.0.0.1'])('returns null for %s', (boundEndpoint) => {
    expect(orcadBoundPort({ boundEndpoint })).toBeNull()
  })
})

describe('readManagedOrcadBoundPort', () => {
  beforeEach(() => {
    execOrcadRemote.mockReset()
  })

  it('follows orcad off a preferred port another runtime holds', async () => {
    execOrcadRemote.mockResolvedValue(readinessLine('ws://127.0.0.1:58520'))
    await expect(readManagedOrcadBoundPort(slot(), 6_768)).resolves.toBe(58_520)
  })

  it.each([
    ['no readiness file', ''],
    ['a readiness without an endpoint', readinessLine(null)]
  ])('falls back to the preferred port for %s (older builds)', async (_label, output) => {
    execOrcadRemote.mockResolvedValue(output)
    await expect(readManagedOrcadBoundPort(slot(), 6_768)).resolves.toBe(6_768)
  })

  it('surfaces a failed host read instead of guessing a port', async () => {
    execOrcadRemote.mockImplementation(async () => {
      throw new Error('channel closed')
    })
    await expect(readManagedOrcadBoundPort(slot(), 6_768)).rejects.toThrow('channel closed')
  })
})

describe('resolveManagedOrcadTunnelPort', () => {
  const link = {
    sshTargetId: 'ssh-1',
    sshTargetGeneration: 1,
    localPort: 46_768,
    remotePort: 6_768
  }
  function input(kind: 'orcadDeployment' | 'sshAccess') {
    return {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only the link fields.
      environment: { [kind]: link } as unknown as KnownRuntimeEnvironment,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: passed through to the mocked context.
      target: { id: 'ssh-1' } as SshTarget,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: passed through to the mocked context.
      connection: {} as SshConnection
    }
  }

  beforeEach(() => {
    execOrcadRemote.mockReset()
    resolveOrcadRemoteContext.mockReset()
  })

  it('reads the active slot of a managed server', async () => {
    resolveOrcadRemoteContext.mockResolvedValue({
      activationRecord: { active: '1.0.0+abc' },
      connection: {},
      host: getRemoteHostPlatform('linux-x64'),
      remoteHome: '/home/deploy'
    })
    execOrcadRemote.mockResolvedValue(readinessLine('ws://127.0.0.1:58520'))
    await expect(resolveManagedOrcadTunnelPort(input('orcadDeployment'))).resolves.toBe(58_520)
  })

  it('keeps the configured port for independent SSH access without touching the host', async () => {
    await expect(resolveManagedOrcadTunnelPort(input('sshAccess'))).resolves.toBe(6_768)
    expect(resolveOrcadRemoteContext).not.toHaveBeenCalled()
  })

  it('tries the preferred port when the host cannot be read; the identity check still guards it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolveOrcadRemoteContext.mockRejectedValue(new Error('platform probe failed'))
    await expect(resolveManagedOrcadTunnelPort(input('orcadDeployment'))).resolves.toBe(6_768)
    warn.mockRestore()
  })
})
