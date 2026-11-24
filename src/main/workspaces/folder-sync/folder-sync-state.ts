import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import {
  FolderProjectSyncPreference,
  FolderSyncManifest,
  type FolderProjectSyncTarget
} from '../../../shared/project/folder-project-sync'
import { durableWriteTempPath, writeFileDurable } from '../../filesystem/durable-file-write'
import { isENOENT } from '../../filesystem/local-file-io/filesystem-path-containment'

const StoredFolderSync = FolderProjectSyncPreference.extend({
  pairingRevision: z.number(),
  pendingCopy: z.boolean().optional(),
  localPath: z.string(),
  resolvedLocalPath: z.string(),
  remote: z.object({ id: z.string(), path: z.string() }),
  baseline: z.tuple([FolderSyncManifest, FolderSyncManifest]).optional()
})

export type StoredFolderSync = z.infer<typeof StoredFolderSync>

export async function readFolderSyncState(path: string): Promise<StoredFolderSync[]> {
  try {
    return z.array(StoredFolderSync).parse(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (isENOENT(error)) {
      return []
    }
    throw error
  }
}

export function writeFolderSyncState(path: string, links: StoredFolderSync[]): Promise<void> {
  return writeFileDurable(durableWriteTempPath(path), path, JSON.stringify(links), 0o600)
}

export function folderSyncTargetKey({
  sourceRepoId,
  environmentId
}: FolderProjectSyncTarget): string {
  return JSON.stringify([sourceRepoId, environmentId])
}
