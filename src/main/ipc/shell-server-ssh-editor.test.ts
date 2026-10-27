import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'

const { handleMock, resolveCliCommandMock, spawnMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  resolveCliCommandMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock },
  shell: { showItemInFolder: vi.fn(), openExternal: vi.fn(), openPath: vi.fn() },
  dialog: { showOpenDialog: vi.fn() }
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

vi.mock('../codex-cli/command', () => ({ resolveCliCommand: resolveCliCommandMock }))

import { registerShellHandlers } from './shell'
import { fingerprintRuntimeSshTarget } from '../ssh/runtime-ssh-target-fingerprint'
import type { ListRuntimeEnvironments } from './shell-editor-ssh-host'

const link = { sshTargetId: 'ssh-1', sshTargetGeneration: 1, localPort: 41000, remotePort: 6768 }
const managedServer = { id: 'env-1', orcadDeployment: link }

function sshTarget(id: string, configHost: string, overrides: Partial<SshTarget> = {}): SshTarget {
  return {
    id,
    label: configHost,
    host: `${configHost}.example.com`,
    port: 22,
    username: 'ada',
    source: 'ssh-config',
    configHost,
    generation: 1,
    orcadFence: { environmentId: 'env-1' },
    ...overrides
  }
}

function spawnedChild(): { once: unknown; off: unknown; unref: unknown } {
  const child = {
    once: vi.fn((eventName: string, callback: () => void) => {
      if (eventName === 'spawn') {
        queueMicrotask(callback)
      }
      return child
    }),
    off: vi.fn(() => child),
    unref: vi.fn()
  }
  return child
}

describe('Open in VS Code for a workspace on a server Orca reaches through an SSH host', () => {
  const sshAccessServer = {
    id: 'env-1',
    sshAccess: {
      ...link,
      endpointId: 'tunnel',
      previousPreferredEndpointId: 'lan',
      targetFingerprint: fingerprintRuntimeSshTarget(sshTarget('ssh-1', 'builder'))
    }
  }
  const targets = new Map<string, SshTarget>()

  beforeEach(() => {
    targets.clear()
    targets.set('ssh-1', sshTarget('ssh-1', 'builder'))
    targets.set('ssh-2', sshTarget('ssh-2', 'other'))
    handleMock.mockReset()
    spawnMock.mockReset()
    spawnMock.mockImplementation(spawnedChild)
    resolveCliCommandMock.mockReset()
    resolveCliCommandMock.mockReturnValue('/usr/local/bin/code')
  })

  function openInEditor(
    listRuntimeEnvironments: ListRuntimeEnvironments,
    request: { connectionId: string; ownerHostId: string }
  ): Promise<unknown> {
    registerShellHandlers({ getSshTarget: (id) => targets.get(id) }, listRuntimeEnvironments)
    const call = handleMock.mock.calls.find((entry) => entry[0] === 'shell:openInExternalEditor')
    return call?.[1]({}, { path: '/home/ada/project', command: 'code', ...request })
  }

  it.each([
    ['managed server', managedServer],
    ['paired server with SSH access', sshAccessServer]
  ])('opens a %s workspace through the host alias', async (_label, environment) => {
    await expect(
      openInEditor(() => [environment], { connectionId: 'ssh-1', ownerHostId: 'runtime:env-1' })
    ).resolves.toEqual({ ok: true })
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/local/bin/code',
      ['--remote', 'ssh-remote+builder', '/home/ada/project'],
      expect.objectContaining({ detached: true, stdio: 'ignore', windowsHide: true, shell: false })
    )
  })

  it.each([
    ['a host the server does not run on', { connectionId: 'ssh-2', ownerHostId: 'runtime:env-1' }],
    ['an unknown server', { connectionId: 'ssh-1', ownerHostId: 'runtime:env-unknown' }],
    ['a local owner', { connectionId: 'ssh-1', ownerHostId: 'local' }]
  ])('refuses %s', async (_label, request) => {
    await expect(openInEditor(() => [managedServer], request)).resolves.toEqual({
      ok: false,
      reason: 'remote-runtime-unsupported'
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it.each([
    ['was re-created since the server linked it', { generation: 2 }],
    ['is fenced to another managed server', { orcadFence: { environmentId: 'env-2' } }]
  ])('refuses a host whose SSH registration %s', async (_label, overrides) => {
    targets.set('ssh-1', sshTarget('ssh-1', 'builder', overrides))
    await expect(
      openInEditor(() => [managedServer], { connectionId: 'ssh-1', ownerHostId: 'runtime:env-1' })
    ).resolves.toEqual({ ok: false, reason: 'remote-runtime-unsupported' })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('refuses SSH access verified against connection settings the host no longer has', async () => {
    targets.set('ssh-1', sshTarget('ssh-1', 'builder', { host: 'elsewhere.example.com' }))
    await expect(
      openInEditor(() => [sshAccessServer], { connectionId: 'ssh-1', ownerHostId: 'runtime:env-1' })
    ).resolves.toEqual({ ok: false, reason: 'remote-runtime-unsupported' })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('refuses when the server list cannot be read', async () => {
    const unreadable: ListRuntimeEnvironments = () => {
      throw new Error('unreadable store')
    }
    await expect(
      openInEditor(unreadable, { connectionId: 'ssh-1', ownerHostId: 'runtime:env-1' })
    ).resolves.toEqual({ ok: false, reason: 'remote-runtime-unsupported' })
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
