/**
 * Destination side of the `editor-drafts` blob. The drafts are applied inside the catalog commit,
 * never after it: the commit verifies the bytes against the signed declaration, writes them into
 * the incoming session, and runs the full session conflict check on that hydrated copy.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  sameOrcadMigrationBlob,
  type OrcadMigrationBlobDescriptor
} from '../../../shared/orcad-migration/orcad-migration-blob-transfer'
import {
  ORCAD_MIGRATION_EDITOR_DRAFTS_KEY,
  orcadMigrationEditorDraftIdentity,
  parseOrcadMigrationEditorDraftsBytes,
  type OrcadMigrationEditorDraft,
  type OrcadMigrationEditorDraftEntry
} from '../../../shared/orcad-migration/orcad-migration-editor-drafts'
import type {
  OrcadMigrationDormantStatePayload,
  OrcadMigrationManifest
} from '../../../shared/orcad-migration/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  getOrcadMigrationReceivedBlobPath,
  listOrcadMigrationReceivedBlobNames,
  stagedOrcadMigrationBlobFiles
} from './orcad-migration-blob-staging'
import {
  assertNoOrcadMigrationSessionConflicts,
  prepareOrcadMigrationWorkspaceSession,
  type PreparedOrcadMigrationWorkspaceSession
} from './orcad-destination-workspace-session'

/**
 * The declared drafts, read from the staged bytes on a first commit or the received bytes on a
 * retry. `expectedBlobs` is optional on the wire, so this refuses a declared-but-absent blob itself.
 */
export function readDeclaredOrcadMigrationEditorDrafts(
  manifest: OrcadMigrationManifest,
  root: string
): OrcadMigrationEditorDraft[] | undefined {
  const declaration = manifest.payload.dormantState?.editorDraftsBlob
  const staged = stagedOrcadMigrationBlobFiles(manifest, root).filter(
    (file) => file.descriptor.blobKind === 'editor-drafts'
  )
  const received = listOrcadMigrationReceivedBlobNames(root, manifest, 'editor-drafts')
  if (!declaration) {
    if (staged.length > 0 || received.length > 0) {
      throw new Error('orcad_migration_editor_drafts_undeclared')
    }
    return undefined
  }
  const descriptor: OrcadMigrationBlobDescriptor = {
    blobKind: 'editor-drafts',
    key: ORCAD_MIGRATION_EDITOR_DRAFTS_KEY,
    sha256: declaration.sha256,
    byteLength: declaration.byteLength
  }
  if (staged.some((file) => !sameOrcadMigrationBlob(file.descriptor, descriptor))) {
    throw new Error('orcad_migration_editor_drafts_digest_mismatch')
  }
  const path = staged[0]?.path ?? getOrcadMigrationReceivedBlobPath(root, manifest, descriptor)
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    throw new Error('orcad_migration_editor_drafts_missing')
  }
  // Hash what is parsed, so nothing can change between the check and the read.
  if (
    bytes.length !== declaration.byteLength ||
    createHash('sha256').update(bytes).digest('hex') !== declaration.sha256
  ) {
    throw new Error('orcad_migration_editor_drafts_digest_mismatch')
  }
  return parseOrcadMigrationEditorDraftsBytes(bytes, declaration)
}

/**
 * Staging has no draft bytes yet, so declared entries are compared without their draft on both
 * sides; the commit reruns the full check on the hydrated session and replaces this result.
 */
export function prepareOrcadMigrationSessionWithDrafts(
  payload: OrcadMigrationDormantStatePayload,
  state: PersistedState,
  drafts: readonly OrcadMigrationEditorDraft[] | undefined
): PreparedOrcadMigrationWorkspaceSession {
  const declaration = payload.editorDraftsBlob
  const incoming = payload.workspaceSession
  if (!declaration || !incoming) {
    return prepareOrcadMigrationWorkspaceSession(incoming, state)
  }
  if (drafts) {
    return prepareOrcadMigrationWorkspaceSession(withEditorDrafts(incoming, drafts), state)
  }
  assertNoOrcadMigrationSessionConflicts(
    withoutEditorDrafts(state.workspaceSession, declaration.entries),
    incoming
  )
  return { incoming, merged: undefined, editorDraftsPending: true }
}

/** A detached copy of `session` with each draft written into its one declared editor entry. */
function withEditorDrafts(
  session: WorkspaceSessionState,
  drafts: readonly OrcadMigrationEditorDraft[]
): WorkspaceSessionState {
  const hydrated = structuredClone(session)
  for (const draft of drafts) {
    const file = hydrated.openFilesByWorktree?.[draft.worktreeKey]?.find(
      (entry) => entry.filePath === draft.filePath
    )
    if (!file) {
      throw new Error('orcad_migration_editor_drafts_declaration_scope_invalid')
    }
    file.dirtyDraftContent = draft.content
  }
  return hydrated
}

function withoutEditorDrafts(
  session: WorkspaceSessionState,
  entries: readonly OrcadMigrationEditorDraftEntry[]
): WorkspaceSessionState {
  const declared = new Set(entries.map(orcadMigrationEditorDraftIdentity))
  const openFiles = session.openFilesByWorktree
  if (!openFiles) {
    return session
  }
  return {
    ...session,
    openFilesByWorktree: Object.fromEntries(
      Object.entries(openFiles).map(([worktreeKey, files]) => [
        worktreeKey,
        files.map((file) => {
          if (
            !declared.has(
              orcadMigrationEditorDraftIdentity({ worktreeKey, filePath: file.filePath })
            )
          ) {
            return file
          }
          const { dirtyDraftContent: _draft, ...rest } = file
          return rest
        })
      ])
    )
  }
}
