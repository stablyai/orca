import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  ORCAD_MIGRATION_BLOB_CHUNK_BYTES,
  type OrcadMigrationBlobDescriptor,
  type OrcadMigrationBlobKind
} from '../shared/orcad-migration/orcad-migration-blob-transfer'
import type { OrcadMigrationEditorDraft } from '../shared/orcad-migration/orcad-migration-editor-drafts'
import type { OrcadMigrationManifest } from '../shared/orcad-migration/orcad-migration-manifest'
import type { PersistedOpenFile } from '../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { getOrcadMigrationReceivedBlobPath } from './persistence/migrating-orcad-catalog/orcad-migration-blob-staging'
import { commitStagedOrcadMigrationCatalogDurably } from './runtime/orcad-migration-catalog-import'
import {
  DORMANT_LEAF_ID,
  DORMANT_WORKTREE_ID,
  dormantState,
  manifest
} from './persistence-orcad-migration-catalog-fixture'
import { testState, type createStore } from './persistence-test-harness'

export type Store = ReturnType<typeof createStore>

export const FILE_A = '/srv/repo-1-worktree/src/a.ts'
export const FILE_B = '/srv/repo-1-worktree/src/b.ts'

export function openFile(filePath: string, dirtyDraftContent?: string): PersistedOpenFile {
  return {
    filePath,
    relativePath: filePath.slice('/srv/repo-1-worktree/'.length),
    worktreeId: DORMANT_WORKTREE_ID,
    language: 'typescript',
    ...(dirtyDraftContent === undefined ? {} : { dirtyDraftContent })
  }
}

export type EncodedBlob = { bytes: Buffer; descriptor: OrcadMigrationBlobDescriptor }

function encodeBlob(blobKind: OrcadMigrationBlobKind, key: string, value: unknown): EncodedBlob {
  const bytes = Buffer.from(JSON.stringify(value))
  return {
    bytes,
    descriptor: {
      blobKind,
      key,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length
    }
  }
}

export function encodeDrafts(drafts: OrcadMigrationEditorDraft[]): EncodedBlob {
  return encodeBlob('editor-drafts', 'drafts', { version: 1, drafts })
}

/** A restore hint for the fixture's dormant pane. */
export const HINTED_PANE = `tab-dormant:${DORMANT_LEAF_ID}`
export function encodeHints(cwd: string): EncodedBlob {
  return encodeBlob('terminal-restore-hints', 'migration', {
    version: 1,
    hints: [{ paneKey: HINTED_PANE, cwd }]
  })
}

/** A capable desktop's manifest: FILE_A's draft shed into the blob, FILE_B clean. */
export function declaredManifest(
  declared: OrcadMigrationBlobDescriptor | null,
  entries = [{ worktreeKey: DORMANT_WORKTREE_ID, filePath: FILE_A }]
): OrcadMigrationManifest {
  const dormant = dormantState()
  dormant.workspaceSession = {
    ...dormant.workspaceSession!,
    openFilesByWorktree: { [DORMANT_WORKTREE_ID]: [openFile(FILE_A), openFile(FILE_B)] }
  }
  if (declared) {
    dormant.editorDraftsBlob = {
      sha256: declared.sha256,
      byteLength: declared.byteLength,
      entries
    }
  }
  const base = manifest()
  return manifest({ payload: { ...base.payload, dormantState: dormant } })
}

export function stageBlob(store: Store, input: OrcadMigrationManifest, blob: EncodedBlob) {
  for (let offset = 0; offset < blob.bytes.length; offset += ORCAD_MIGRATION_BLOB_CHUNK_BYTES) {
    store.stageOrcadMigrationBlobChunk({
      migrationId: input.migrationId,
      manifestSha256: input.manifestSha256,
      blob: blob.descriptor,
      offset,
      bytesBase64: blob.bytes
        .subarray(offset, offset + ORCAD_MIGRATION_BLOB_CHUNK_BYTES)
        .toString('base64')
    })
  }
}

export function receivedDraftsPath(input: OrcadMigrationManifest): string {
  return getOrcadMigrationReceivedBlobPath(join(testState.dir, 'orcad-migration-blobs'), input, {
    blobKind: 'editor-drafts',
    key: 'drafts'
  })
}

export function draftOf(store: Store, filePath: string): string | undefined {
  return store
    .getWorkspaceSession()
    .openFilesByWorktree?.[DORMANT_WORKTREE_ID]?.find((file) => file.filePath === filePath)
    ?.dirtyDraftContent
}

export function setDestinationFiles(store: Store, files: PersistedOpenFile[]): void {
  store.setWorkspaceSession({
    ...getDefaultWorkspaceSession(),
    openFilesByWorktree: { [DORMANT_WORKTREE_ID]: files }
  })
}

export function commitDurably(store: Store, input: OrcadMigrationManifest) {
  return commitStagedOrcadMigrationCatalogDurably({
    store,
    manifest: input,
    onDurableCommit: () => {}
  })
}

export const DRAFT_A = {
  worktreeKey: DORMANT_WORKTREE_ID,
  filePath: FILE_A,
  content: 'unsaved A\n'
}
