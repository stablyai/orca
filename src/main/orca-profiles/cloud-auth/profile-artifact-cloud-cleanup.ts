import { readFile, rm, stat } from 'node:fs/promises'
import { stageCredentialFile } from '../../credentials/credential-file-io'
import { bestEffortFsyncDirectory } from '../../../shared/secure-storage/secure-file-async-write'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type {
  OrcaProfileCloudSummary,
  OrcaProfileSummary
} from '../../../shared/orca-profiles/orca-profiles'
import {
  bestEffortFsyncDirectorySync,
  writeDurableSecureJsonFile
} from '../../../shared/secure-storage/secure-file'
import {
  clearArtifactCreateIntents,
  clearArtifactCreateIntentsAsync
} from '../../artifacts/artifact-create-intent-store'
import {
  clearArtifactShareRecords,
  clearArtifactShareRecordsAsync
} from '../../artifacts/artifact-share-record-store'
import { getOrcaProfileDirectory } from '../profile-storage-paths'

type ArtifactCloudCleanupMarker = {
  version: 1
  phase: 'prepared' | 'committed'
  targetIdentity: string
}

function cleanupMarkerPath(profileId: string, userDataPath: string): string {
  return join(getOrcaProfileDirectory(profileId, userDataPath), 'artifact-cloud-cleanup.json')
}

export function artifactCloudIdentity(cloud: OrcaProfileCloudSummary | undefined): string {
  return cloud
    ? JSON.stringify([cloud.userId, cloud.cloudProfileId, cloud.activeOrgId ?? ''])
    : 'local'
}

export function prepareArtifactCloudCleanup(
  profileId: string,
  userDataPath: string,
  targetCloud: OrcaProfileCloudSummary | undefined
): void {
  writeDurableSecureJsonFile(cleanupMarkerPath(profileId, userDataPath), {
    version: 1,
    phase: 'prepared',
    targetIdentity: artifactCloudIdentity(targetCloud)
  } satisfies ArtifactCloudCleanupMarker)
}

function readCleanupMarker(
  profileId: string,
  userDataPath: string
): ArtifactCloudCleanupMarker | null {
  const path = cleanupMarkerPath(profileId, userDataPath)
  if (!existsSync(path)) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error('Artifact cloud cleanup marker could not be read safely.', { cause: error })
  }
  return parseCleanupMarker(parsed)
}

export function artifactCloudCleanupNeedsCommit(
  profileId: string,
  userDataPath: string,
  targetCloud: OrcaProfileCloudSummary | undefined
): boolean {
  const marker = readCleanupMarker(profileId, userDataPath)
  return (
    marker?.phase === 'prepared' && marker.targetIdentity === artifactCloudIdentity(targetCloud)
  )
}

export function commitArtifactCloudCleanup(
  profileId: string,
  userDataPath: string,
  targetCloud: OrcaProfileCloudSummary | undefined
): void {
  const targetIdentity = artifactCloudIdentity(targetCloud)
  const marker = readCleanupMarker(profileId, userDataPath)
  if (marker?.phase !== 'prepared' || marker.targetIdentity !== targetIdentity) {
    throw new Error('Artifact cloud cleanup marker does not match the profile transition.')
  }
  writeDurableSecureJsonFile(cleanupMarkerPath(profileId, userDataPath), {
    version: 1,
    phase: 'committed',
    targetIdentity
  } satisfies ArtifactCloudCleanupMarker)
}

export function completeArtifactCloudCleanupIfCommitted(
  profileId: string,
  userDataPath: string,
  currentCloud: OrcaProfileCloudSummary | undefined
): void {
  const marker = readCleanupMarker(profileId, userDataPath)
  if (
    marker?.phase !== 'committed' ||
    marker.targetIdentity !== artifactCloudIdentity(currentCloud)
  ) {
    return
  }
  clearArtifactCreateIntents(profileId, userDataPath)
  clearArtifactShareRecords(profileId, userDataPath)
  rmSync(cleanupMarkerPath(profileId, userDataPath), { force: true })
  bestEffortFsyncDirectorySync(getOrcaProfileDirectory(profileId, userDataPath))
}

function assertArtifactCloudCleanupReady(
  profileId: string,
  userDataPath: string,
  currentCloud: OrcaProfileCloudSummary | undefined
): void {
  const marker = readCleanupMarker(profileId, userDataPath)
  if (
    marker?.phase === 'prepared' &&
    marker.targetIdentity === artifactCloudIdentity(currentCloud)
  ) {
    throw new Error('The Orca profile transition must be retried before publishing artifacts.')
  }
}

export function prepareArtifactCloudUse(
  profile: Pick<OrcaProfileSummary, 'id' | 'cloud'>,
  userDataPath: string
): void {
  completeArtifactCloudCleanupIfCommitted(profile.id, userDataPath, profile.cloud)
  assertArtifactCloudCleanupReady(profile.id, userDataPath, profile.cloud)
}

export async function prepareArtifactCloudCleanupAsync(
  profileId: string,
  userDataPath: string,
  targetCloud: OrcaProfileCloudSummary | undefined
): Promise<void> {
  await stageCredentialFile(
    cleanupMarkerPath(profileId, userDataPath),
    JSON.stringify({
      version: 1,
      phase: 'prepared',
      targetIdentity: artifactCloudIdentity(targetCloud)
    } satisfies ArtifactCloudCleanupMarker),
    { createDirectory: true, durable: true }
  )
}

async function readCleanupMarkerAsync(
  profileId: string,
  userDataPath: string
): Promise<ArtifactCloudCleanupMarker | null> {
  const path = cleanupMarkerPath(profileId, userDataPath)
  if (!(await cleanupMarkerExists(path))) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error('Artifact cloud cleanup marker could not be read safely.', { cause: error })
  }
  return parseCleanupMarker(parsed)
}

export async function artifactCloudCleanupNeedsCommitAsync(
  profileId: string,
  userDataPath: string,
  targetCloud: OrcaProfileCloudSummary | undefined
): Promise<boolean> {
  const marker = await readCleanupMarkerAsync(profileId, userDataPath)
  return (
    marker?.phase === 'prepared' && marker.targetIdentity === artifactCloudIdentity(targetCloud)
  )
}

export async function commitArtifactCloudCleanupAsync(
  profileId: string,
  userDataPath: string,
  targetCloud: OrcaProfileCloudSummary | undefined
): Promise<void> {
  const targetIdentity = artifactCloudIdentity(targetCloud)
  const marker = await readCleanupMarkerAsync(profileId, userDataPath)
  if (marker?.phase !== 'prepared' || marker.targetIdentity !== targetIdentity) {
    throw new Error('Artifact cloud cleanup marker does not match the profile transition.')
  }
  await stageCredentialFile(
    cleanupMarkerPath(profileId, userDataPath),
    JSON.stringify({
      version: 1,
      phase: 'committed',
      targetIdentity
    } satisfies ArtifactCloudCleanupMarker),
    { createDirectory: true, durable: true }
  )
}

export async function completeArtifactCloudCleanupIfCommittedAsync(
  profileId: string,
  userDataPath: string,
  currentCloud: OrcaProfileCloudSummary | undefined
): Promise<void> {
  const marker = await readCleanupMarkerAsync(profileId, userDataPath)
  if (
    marker?.phase !== 'committed' ||
    marker.targetIdentity !== artifactCloudIdentity(currentCloud)
  ) {
    return
  }
  await clearArtifactCreateIntentsAsync(profileId, userDataPath)
  await clearArtifactShareRecordsAsync(profileId, userDataPath)
  await rm(cleanupMarkerPath(profileId, userDataPath), { force: true })
  await bestEffortFsyncDirectory(getOrcaProfileDirectory(profileId, userDataPath))
}

async function cleanupMarkerExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function parseCleanupMarker(parsed: unknown): ArtifactCloudCleanupMarker {
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('phase' in parsed) ||
    (parsed.phase !== 'prepared' && parsed.phase !== 'committed') ||
    !('targetIdentity' in parsed) ||
    typeof parsed.targetIdentity !== 'string'
  ) {
    throw new Error('Artifact cloud cleanup marker has an unsupported format.')
  }
  return { version: 1, phase: parsed.phase, targetIdentity: parsed.targetIdentity }
}
