import { ipcMain } from 'electron'
import type {
  OrcadManagedConversionPreview,
  OrcadManagedConversionResult,
  OrcadManagedPendingMigrationRow
} from '../../shared/orcad-managed-runtime'
import { listPendingManagedOrcadMigrations } from '../ssh/orcad-managed-migration-status'
import { requireManagedOrcadInfrastructure } from '../ssh/orcad-managed-runtime-context'
import { createOrcadMigrationManifest } from '../ssh/orcad-migration-manifest-export'
import { assessOrcadMigrationTerminals } from '../ssh/orcad-migration-terminal-gate'
import { convertSshTargetToManagedOrcad } from '../ssh/orcad-runtime-conversion'
import { orcadMigrationRelayPtyLister } from '../ssh/orcad-migration-relay-pty-lister'
import { conversionCollaborators } from '../ssh/orcad-runtime-conversion-wiring'
import { preflightOrcadMigrationExport } from '../ssh/ssh-target-orcad-preflight'
import { requiredString } from './orcad-runtime-lifecycle-handlers'

export function registerOrcadRuntimeConversionHandlers(getUserDataPath: () => string): void {
  ipcMain.handle(
    'runtimeEnvironments:previewOrcadConversion',
    (_event, args: { sshTargetId: string }): Promise<OrcadManagedConversionPreview> =>
      previewConversion(requiredString(args?.sshTargetId, 'SSH target'))
  )
  ipcMain.handle(
    'runtimeEnvironments:convertSshHostToManagedOrcad',
    (
      _event,
      args: { sshTargetId: string; name: string }
    ): Promise<OrcadManagedConversionResult> => {
      const sshTargetId = requiredString(args?.sshTargetId, 'SSH target')
      return convertSshTargetToManagedOrcad(getUserDataPath(), {
        sshTargetId,
        name: requiredString(args?.name, 'Server name'),
        ...conversionCollaborators(sshTargetId)
      })
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:listPendingOrcadMigrations',
    (): OrcadManagedPendingMigrationRow[] => listPendingManagedOrcadMigrations(getUserDataPath())
  )
}

/** Read-only: exports nothing and fences nothing. */
async function previewConversion(sshTargetId: string): Promise<OrcadManagedConversionPreview> {
  const { targetStore } = requireManagedOrcadInfrastructure()
  const store = targetStore.getOrcadMigrationSource()
  const target = store.getSshTarget(sshTargetId)
  if (!target) {
    throw new Error('SSH target is required.')
  }
  const preflight = preflightOrcadMigrationExport(store, sshTargetId)
  const manifest = createOrcadMigrationManifest(store, target)
  const dormant = manifest.payload.dormantState
  const terminals = await assessOrcadMigrationTerminals(
    store,
    sshTargetId,
    orcadMigrationRelayPtyLister(sshTargetId)
  )
  return {
    sshTargetId,
    targetLabel: preflight.targetLabel,
    moves: {
      repositories: manifest.payload.repositories.length,
      projectGroups: manifest.payload.projectGroups.length,
      folderWorkspaces: manifest.payload.folderWorkspaces.length,
      automations: dormant?.automations?.length ?? 0,
      workspaceSession: Boolean(dormant?.workspaceSession)
    },
    blockers: preflight.blockers.filter(
      (blocker) =>
        blocker.category !== 'drainable-static-state' &&
        blocker.code !== 'orcad_migration_saved_port_forwards'
    ),
    terminals:
      terminals.verdict === 'exited'
        ? { verdict: 'exited' }
        : { verdict: terminals.verdict, ptyIds: terminals.ptyIds, reason: terminals.reason }
  }
}
