import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OrcadMigrationBlobDescriptor } from '../shared/orcad-migration/orcad-migration-blob-transfer'
import type { OrcadMigrationManifest } from '../shared/orcad-migration/orcad-migration-manifest'
import { folderWorkspaceKey } from '../shared/workspace-scope'
import { getOrcadMigrationReceivedBlobPath } from './persistence/migrating-orcad-catalog/orcad-migration-blob-staging'
import { buildWslMoveShellHistoryBlobs } from './persistence/moving-wsl-projects/wsl-move-shell-history-blobs'
import { commitStagedOrcadMigrationCatalogDurably } from './runtime/orcad-migration-catalog-import'
import { getHistoryRoot } from './terminal-history-paths'
import { hashWorktreeId } from './terminal-history-id'
import { FOLDER_WORKSPACE } from './persistence-orcad-migration-catalog-fixture'
import { testState, type createStore } from './persistence-test-harness'

type Store = ReturnType<typeof createStore>
export type EncodedBlob = { descriptor: OrcadMigrationBlobDescriptor; bytes: Buffer }

export const FOLDER_KEY = folderWorkspaceKey(FOLDER_WORKSPACE.id)
export const ZSH = ': 1700000000:0;make test\n'
export const BASH = 'git status\n'

// What the desktop sends for the moved worktree: its source ids already equal the host's here.
export async function encodedHistories(
  desktopHistory: string,
  files: { worktreeId: string; file: string; content: string }[]
): Promise<EncodedBlob[]> {
  for (const { worktreeId, file, content } of files) {
    const directory = join(desktopHistory, hashWorktreeId(worktreeId))
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, file), content)
  }
  const ids = [...new Set(files.map((entry) => entry.worktreeId))]
  const blobs = await buildWslMoveShellHistoryBlobs({
    distro: 'Ubuntu',
    historyRoot: desktopHistory,
    worktrees: ids.map((id) => ({ sourceWorktreeId: id, destinationWorktreeId: id }))
  })
  return Promise.all(
    blobs.descriptors.map(async (descriptor) => ({
      descriptor,
      bytes: await blobs.source.readChunk(descriptor, 0, descriptor.byteLength)
    }))
  )
}

export function rawBlob(key: string, bytes: Buffer): EncodedBlob {
  return {
    bytes,
    descriptor: {
      blobKind: 'shell-history',
      key,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length
    }
  }
}

export function stage(store: Store, input: OrcadMigrationManifest, blobs: EncodedBlob[]): void {
  store.stageOrcadMigrationCatalog(input)
  for (const blob of blobs) {
    store.stageOrcadMigrationBlobChunk({
      migrationId: input.migrationId,
      manifestSha256: input.manifestSha256,
      blob: blob.descriptor,
      offset: 0,
      bytesBase64: blob.bytes.toString('base64')
    })
  }
}

export function receivedPath(input: OrcadMigrationManifest, key: string): string {
  return getOrcadMigrationReceivedBlobPath(join(testState.dir, 'orcad-migration-blobs'), input, {
    blobKind: 'shell-history',
    key
  })
}

export function hostHistoryDirectory(worktreeId: string): string {
  return join(getHistoryRoot(), hashWorktreeId(worktreeId))
}

export function hostHistory(worktreeId: string, file: string): string | null {
  const path = join(hostHistoryDirectory(worktreeId), file)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/** A runtime's live-shell check on a host where no shell runs. */
export const noLiveShells = (): boolean => false

export async function commitDurably(store: Store, input: OrcadMigrationManifest): Promise<string> {
  const result = await commitStagedOrcadMigrationCatalogDurably({
    store,
    manifest: input,
    worktreeHasLiveShells: noLiveShells,
    onDurableCommit: () => {}
  })
  return result.state
}
