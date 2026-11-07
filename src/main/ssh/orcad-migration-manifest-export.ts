/** Export copied catalog/dormant state without mutating source. Path rewriting precedes signing; source ownership remains until cutover establishes destination authority. */
import { createHash, randomUUID } from 'node:crypto'
import {
  MAX_ORCAD_MIGRATION_MANIFEST_BYTES,
  ORCAD_MIGRATION_MANIFEST_VERSION,
  parseOrcadMigrationManifest
} from '../../shared/orcad-migration/orcad-migration-manifest-validation'
import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationDormantStatePayload,
  OrcadMigrationManifest
} from '../../shared/orcad-migration/orcad-migration-manifest'
import {
  ORCAD_MIGRATION_BLOB_KIND_CONTRACTS,
  type OrcadMigrationBlobDescriptor
} from '../../shared/orcad-migration/orcad-migration-blob-transfer'
import {
  orcadMigrationAutomationRunHistoryBlob,
  serializeOrcadMigrationAutomationRunHistory,
  withOrcadMigrationAutomationRunHistory
} from '../../shared/orcad-migration/orcad-migration-automation-run-history'
import type { SshTarget } from '../../shared/ssh-types'
import { REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES } from '../../shared/remote-runtime/remote-runtime-memory-limits'
import type { Store } from '../persistence/loading-store/store'
import { collectOrcadMigrationSourceCatalog } from '../persistence/migrating-orcad-catalog/orcad-source-catalog'
import { computeOrcadMigrationManifestSha256 } from '../orcad/orcad-migration-manifest-digest'
import {
  IDENTITY_ORCAD_MIGRATION_PATH_REWRITER,
  rewriteOrcadMigrationPayloadPaths,
  type OrcadMigrationPathRewriter
} from './orcad-migration-path-rewrite'

export type OrcadMigrationExportStore = Pick<
  Store,
  | 'collectOrcadMigrationSourceDormantState'
  | 'getFolderWorkspaces'
  | 'getProjectGroups'
  | 'getRepos'
> & {
  /** Groups the server's record wins for: still read for row ownership, never exported. */
  serverOwnedProjectGroupIds?: ReadonlySet<string>
}

export type OrcadMigrationManifestExportOptions = {
  migrationId?: string
  now?: () => Date
  destinationEnvironmentId?: string
  onlyCatalog?: OrcadMigrationCatalogIds
  /** Maps source paths to destination paths before signing; identity for an SSH host. */
  rewrite?: OrcadMigrationPathRewriter
  /** Re-export a journal written before run history moved out of the manifest, as it was signed. */
  inlineAutomationRuns?: boolean
}

export type OrcadMigrationExportedBlob = {
  descriptor: OrcadMigrationBlobDescriptor
  bytes: Buffer
}

export type OrcadMigrationManifestExport = {
  manifest: OrcadMigrationManifest
  /** The bytes of every blob the manifest names. */
  blobs: OrcadMigrationExportedBlob[]
}

export function createOrcadMigrationManifest(
  store: OrcadMigrationExportStore,
  target: SshTarget,
  options: OrcadMigrationManifestExportOptions = {}
): OrcadMigrationManifest {
  return exportOrcadMigrationManifest(store, target, options).manifest
}

export function exportOrcadMigrationManifest(
  store: OrcadMigrationExportStore,
  target: SshTarget,
  options: OrcadMigrationManifestExportOptions = {}
): OrcadMigrationManifestExport {
  const rewrite = options.rewrite ?? IDENTITY_ORCAD_MIGRATION_PATH_REWRITER
  const collected = restrictCatalog(
    collectOrcadMigrationSourceCatalog(store, target),
    options.onlyCatalog
  )
  const serverOwned = store.serverOwnedProjectGroupIds
  const sourcePayload = serverOwned
    ? {
        ...collected,
        projectGroups: collected.projectGroups.filter((group) => !serverOwned.has(group.id))
      }
    : collected
  const source = {
    sshTargetId: target.id,
    sshTargetGeneration: target.generation ?? null,
    targetLabel: target.label
  }
  const dormantState = store.collectOrcadMigrationSourceDormantState(
    source,
    sourcePayload,
    options.destinationEnvironmentId
  )
  // Select dormant state using source identities before rewriting destination paths.
  const rewritten = rewriteOrcadMigrationPayloadPaths(
    { ...sourcePayload, ...(hasDormantState(dormantState) ? { dormantState } : {}) },
    rewrite
  )
  const { payload, runHistory } = options.inlineAutomationRuns
    ? { payload: rewritten, runHistory: null }
    : moveAutomationRunsToBlob(rewritten)
  const unsigned = {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: options.migrationId ?? randomUUID(),
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    source,
    payload,
    ...(options.destinationEnvironmentId
      ? { destinationEnvironmentId: options.destinationEnvironmentId }
      : {})
  }
  try {
    // Sign what the journal and the host read back: the parsed form (the parser keeps only the fields
    // it knows) of the JSON (a value with toJSON serializes differently), never the live objects.
    const { manifestSha256: _unsigned, ...normalized } = parseOrcadMigrationManifest({
      ...JSON.parse(JSON.stringify(unsigned)),
      manifestSha256: UNSIGNED_DIGEST
    })
    if (runHistory) {
      // Refuse here what the destination's commit would refuse, while nothing is fenced.
      withOrcadMigrationAutomationRunHistory(normalized, runHistory.bytes.toString('utf8'))
    }
    return {
      manifest: { ...normalized, manifestSha256: computeOrcadMigrationManifestSha256(normalized) },
      blobs: runHistory ? [runHistory] : []
    }
  } catch (error) {
    if (error instanceof Error && error.message === ORCAD_MIGRATION_MANIFEST_TOO_LARGE) {
      throw new Error(describeOversizedOrcadMigrationPayload(payload))
    }
    throw error
  }
}

/** Run history scales with every run ever kept, so it travels beside the manifest, never in it. */
function moveAutomationRunsToBlob(payload: OrcadMigrationCatalogPayload): {
  payload: OrcadMigrationCatalogPayload
  runHistory: OrcadMigrationExportedBlob | null
} {
  if (!payload.dormantState?.automationRuns?.length) {
    return { payload, runHistory: null }
  }
  const { automationRuns, ...dormantState } = payload.dormantState
  // The JSON round trip matches what the manifest's own normalization keeps.
  const bytes = Buffer.from(
    serializeOrcadMigrationAutomationRunHistory(JSON.parse(JSON.stringify(automationRuns))),
    'utf8'
  )
  const maxBytes = ORCAD_MIGRATION_BLOB_KIND_CONTRACTS['automation-run-history'].maxBytes
  if (bytes.length > maxBytes) {
    throw new Error(
      `This SSH host's automation run history is too large to move to its Orca server ` +
        `(${formatKib(bytes.length)}, limit ${formatKib(maxBytes)}). Delete automations you no ` +
        `longer need from this host's projects; their run history goes with them. Then reconnect. ` +
        `(orcad_migration_automation_run_history_too_large)`
    )
  }
  const ref = { sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length }
  return {
    payload: {
      ...payload,
      dormantState: { ...dormantState, automationRunHistory: ref }
    },
    runHistory: { descriptor: orcadMigrationAutomationRunHistoryBlob(ref), bytes }
  }
}

const ORCAD_MIGRATION_MANIFEST_TOO_LARGE = 'orcad_migration_manifest_too_large'
const UNSIGNED_DIGEST = '0'.repeat(64)

// Request id, device token, method name and JSON framing around the params.
const REQUEST_ENVELOPE_RESERVE_BYTES = 1024
/** The largest catalog-request params that still fit the host's sealed inbound frame. */
export const ORCAD_MIGRATION_REQUEST_PARAMS_BUDGET_BYTES =
  REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES - REQUEST_ENVELOPE_RESERVE_BYTES

/** Reject oversized manifest requests before fencing: stage/state/full abort would all exceed the sealed frame and close its socket. */
export function assertOrcadMigrationRequestFits(params: {
  manifest: OrcadMigrationManifest
}): void {
  if (!orcadMigrationRequestFits(params)) {
    throw new Error(
      describeOversizedOrcadMigrationPayload(
        params.manifest.payload,
        ORCAD_MIGRATION_REQUEST_PARAMS_BUDGET_BYTES
      )
    )
  }
}

export function orcadMigrationRequestFits(params: { manifest: OrcadMigrationManifest }): boolean {
  return (
    Buffer.byteLength(JSON.stringify(params), 'utf8') <= ORCAD_MIGRATION_REQUEST_PARAMS_BUDGET_BYTES
  )
}

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

function formatKib(bytes: number): string {
  return `${Math.ceil(bytes / 1024)} KB`
}

export type OrcadMigrationCatalogIds = {
  repositoryIds: ReadonlySet<string>
  folderWorkspaceIds: ReadonlySet<string>
  projectGroupIds: ReadonlySet<string>
}

export function orcadMigrationCatalogIds(
  payloads: readonly OrcadMigrationCatalogPayload[]
): OrcadMigrationCatalogIds {
  return {
    repositoryIds: new Set(payloads.flatMap((p) => p.repositories.map((row) => row.id))),
    folderWorkspaceIds: new Set(payloads.flatMap((p) => p.folderWorkspaces.map((row) => row.id))),
    projectGroupIds: new Set(payloads.flatMap((p) => p.projectGroups.map((row) => row.id)))
  }
}

function restrictCatalog(
  payload: OrcadMigrationCatalogPayload,
  ids: OrcadMigrationCatalogIds | undefined
): OrcadMigrationCatalogPayload {
  if (!ids) {
    return payload
  }
  return {
    repositories: payload.repositories.filter((row) => ids.repositoryIds.has(row.id)),
    folderWorkspaces: payload.folderWorkspaces.filter((row) => ids.folderWorkspaceIds.has(row.id)),
    projectGroups: payload.projectGroups.filter((row) => ids.projectGroupIds.has(row.id))
  }
}

export function hasDormantState(state: OrcadMigrationDormantStatePayload): boolean {
  return (
    state.worktreeMeta.length > 0 ||
    state.worktreeLineage.length > 0 ||
    state.workspaceLineage.length > 0 ||
    state.sparsePresets.length > 0 ||
    state.retiredWorktreeNames.length > 0 ||
    state.retiredWorktreeNamespaces.length > 0 ||
    state.workspaceSession !== undefined ||
    (state.terminalScrollbackSnapshots?.length ?? 0) > 0 ||
    (state.automations?.length ?? 0) > 0 ||
    (state.automationRuns?.length ?? 0) > 0 ||
    state.automationRunHistory !== undefined ||
    (state.clientState !== undefined && Object.keys(state.clientState).length > 0)
  )
}
