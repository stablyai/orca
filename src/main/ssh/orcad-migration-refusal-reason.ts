import type {
  OrcadMigrationBlocker,
  OrcadMigrationDependencyKind
} from '../../shared/orcad-migration-preflight'

const DEPENDENCY_WORDS: Record<OrcadMigrationDependencyKind, string> = {
  'saved-port-forward': 'saved port forwards',
  'terminal-lease': 'terminals still running',
  'terminal-recovery': 'terminals waiting to reconnect',
  'workspace-session': 'saved tabs and panes',
  'worktree-metadata': 'saved workspace details',
  'worktree-lineage': 'workspace history',
  'workspace-lineage': 'workspace history',
  'sparse-preset': 'sparse checkout presets',
  'retired-worktree-name': 'retired workspace names',
  automation: 'automations',
  'automation-run': 'automation runs',
  'mobile-tab-selection': 'mobile tab selections',
  'ui-routing': 'sidebar settings'
}

function blockerWords(blocker: OrcadMigrationBlocker): string[] {
  switch (blocker.code) {
    case 'orcad_migration_target_not_found':
      return ['the host is no longer saved']
    case 'orcad_migration_target_owned':
      return ['another server holds it']
    case 'orcad_migration_owner_unrecorded':
      return ['its server record is missing']
    case 'orcad_migration_direct_ssh_terminal_leases':
      return ['terminals still running']
    case 'orcad_migration_dependent_state':
      return blocker.dependencies.map(({ kind }) => DEPENDENCY_WORDS[kind])
    case 'orcad_migration_dependency_unverifiable':
      return ['saved state Orca could not read']
    case 'orcad_migration_direct_ssh_repositories':
    case 'orcad_migration_direct_ssh_folder_workspaces':
    case 'orcad_migration_saved_port_forwards':
      // These move with the host or stay behind; they never refuse a conversion.
      return []
  }
}

/** The refusal names what blocks, in plain words; the status line shows only this text. */
export function orcadMigrationRefusalReason(blockers: readonly OrcadMigrationBlocker[]): string {
  const words = [...new Set(blockers.flatMap(blockerWords))]
  return words.length > 0
    ? `This SSH host cannot move yet: ${words.join(', ')}.`
    : 'This SSH host cannot move yet.'
}
