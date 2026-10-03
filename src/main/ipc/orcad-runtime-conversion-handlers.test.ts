import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  convert: vi.fn(),
  pending: vi.fn(),
  preflight: vi.fn(),
  manifest: vi.fn(),
  terminals: vi.fn(),
  inventory: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../ssh/orcad-runtime-conversion', () => ({
  convertSshTargetToManagedOrcad: mocks.convert
}))
vi.mock('../ssh/orcad-managed-migration-status', () => ({
  listPendingManagedOrcadMigrations: mocks.pending
}))
vi.mock('../ssh/orcad-managed-runtime-context', () => ({
  requireManagedOrcadInfrastructure: () => ({
    targetStore: {
      getOrcadMigrationSource: () => ({ getSshTarget: () => ({ id: 'ssh-1', label: 'Builder' }) })
    }
  })
}))
vi.mock('../ssh/ssh-target-orcad-preflight', () => ({
  preflightOrcadMigrationExport: mocks.preflight
}))
vi.mock('../ssh/orcad-migration-manifest-export', () => ({
  createOrcadMigrationManifest: mocks.manifest
}))
vi.mock('../ssh/orcad-migration-terminal-gate', () => ({
  assessOrcadMigrationTerminals: mocks.terminals
}))
vi.mock('../ssh/orcad-migration-relay-pty-lister', () => ({
  orcadMigrationRelayPtyLister: mocks.inventory
}))
vi.mock('../ssh/orcad-runtime-conversion-wiring', () => ({
  conversionCollaborators: () => ({ marker: 'live-collaborators' })
}))

const { registerOrcadRuntimeConversionHandlers } =
  await import('./orcad-runtime-conversion-handlers')

function handler(channel: string): (_event: unknown, args?: unknown) => unknown {
  const registration = mocks.handle.mock.calls.find(([name]) => name === channel)
  if (!registration) {
    throw new Error(`${channel} handler was not registered`)
  }
  return registration[1]
}

describe('managed server conversion IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerOrcadRuntimeConversionHandlers(() => '/profile')
  })

  it('previews what moves and keeps only blockers that stop the move', async () => {
    mocks.preflight.mockReturnValue({
      targetLabel: 'Builder',
      blockers: [
        { code: 'orcad_migration_direct_ssh_repositories', category: 'drainable-static-state' },
        { code: 'orcad_migration_saved_port_forwards', category: 'client-owned-state' },
        { code: 'orcad_migration_target_owned', category: 'exclusive-ownership' }
      ]
    })
    mocks.manifest.mockReturnValue({
      payload: {
        repositories: [{}, {}],
        projectGroups: [{}],
        folderWorkspaces: [{}],
        dormantState: { automations: [{}], workspaceSession: {} }
      }
    })
    mocks.terminals.mockResolvedValue({ verdict: 'live', ptyIds: ['p'], reason: 'running' })
    await expect(
      handler('runtimeEnvironments:previewOrcadConversion')(null, { sshTargetId: 'ssh-1' })
    ).resolves.toEqual({
      sshTargetId: 'ssh-1',
      targetLabel: 'Builder',
      moves: {
        repositories: 2,
        projectGroups: 1,
        folderWorkspaces: 1,
        automations: 1,
        workspaceSession: true
      },
      blockers: [{ code: 'orcad_migration_target_owned', category: 'exclusive-ownership' }],
      terminals: { verdict: 'live', ptyIds: ['p'], reason: 'running' }
    })
    expect(mocks.inventory).toHaveBeenCalledWith('ssh-1')
  })

  it('converts with the live collaborators and lists pending migrations from the profile', async () => {
    mocks.convert.mockResolvedValue({ outcome: 'converted' })
    await handler('runtimeEnvironments:convertSshHostToManagedOrcad')(null, {
      sshTargetId: ' ssh-1 ',
      name: 'Builder'
    })
    expect(mocks.convert).toHaveBeenCalledWith('/profile', {
      sshTargetId: 'ssh-1',
      name: 'Builder',
      marker: 'live-collaborators'
    })
    handler('runtimeEnvironments:listPendingOrcadMigrations')(null)
    expect(mocks.pending).toHaveBeenCalledWith('/profile')
  })
})
