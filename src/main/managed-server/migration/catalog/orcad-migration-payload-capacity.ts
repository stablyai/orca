import { MAX_ORCAD_MIGRATION_MANIFEST_BYTES } from '../../../../shared/orcad-migration/orcad-migration-manifest-validation'
import type { OrcadMigrationCatalogPayload } from '../../../../shared/orcad-migration/orcad-migration-manifest'

export const ORCAD_MIGRATION_MANIFEST_TOO_LARGE = 'orcad_migration_manifest_too_large'

/** Name the largest sections and how to trim the largest; a bare error code was unhelpful (#30126). */
export function describeOversizedOrcadMigrationPayload(
  payload: OrcadMigrationCatalogPayload,
  limitBytes = MAX_ORCAD_MIGRATION_MANIFEST_BYTES
): string {
  const dormant = payload.dormantState
  const removeProjects = 'remove projects you no longer use from this host'
  const closeTabs = 'close tabs you no longer need'
  const parts: [words: string, value: unknown, trim: string][] = [
    ['projects', payload.repositories, removeProjects],
    ['folder workspaces', payload.folderWorkspaces, removeProjects],
    ['project groups', payload.projectGroups, removeProjects],
    ['saved tabs and panes', dormant?.workspaceSession, closeTabs],
    ['saved terminal history', dormant?.terminalScrollbackSnapshots, closeTabs],
    ['saved workspace details', dormant?.worktreeMeta, 'delete workspaces you no longer need'],
    [
      'workspace history',
      [dormant?.worktreeLineage, dormant?.workspaceLineage],
      'delete workspaces you no longer need'
    ],
    [
      'sparse checkout presets',
      dormant?.sparsePresets,
      'delete sparse checkout presets you no longer use'
    ],
    [
      'retired workspace names',
      [dormant?.retiredWorktreeNames, dormant?.retiredWorktreeNamespaces],
      removeProjects
    ],
    [
      'automations',
      [dormant?.automations, dormant?.automationRuns],
      "delete automations you no longer need from this host's projects"
    ],
    ['sidebar and browser settings', dormant?.clientState, closeTabs]
  ]
  const largest = parts
    .map(([words, value, trim]) => ({
      words,
      trim,
      bytes: new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength
    }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 3)
  const { trim } = largest[0]
  return (
    `This SSH host's saved state is too large to move to its Orca server (limit ` +
    `${formatKib(limitBytes)}). Largest parts: ` +
    `${largest.map(({ words, bytes }) => `${words} (${formatKib(bytes)})`).join(', ')}. ` +
    `${trim.charAt(0).toUpperCase()}${trim.slice(1)}, then reconnect. ` +
    `(${ORCAD_MIGRATION_MANIFEST_TOO_LARGE})`
  )
}

export function formatKib(bytes: number): string {
  return `${Math.ceil(bytes / 1024)} KB`
}
