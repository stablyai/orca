import {
  isArtifactShareRecord,
  pruneRecords,
  type ArtifactShareRecord
} from './artifact-share-record-retention'

export type ArtifactShareRecordFile = {
  version: 2
  lifecycleGeneration: number
  lifecycleNonce: string
  shares: Record<string, ArtifactShareRecord>
}

type ParsedArtifactShareRecordFile = {
  version?: unknown
  lifecycleGeneration?: unknown
  lifecycleNonce?: unknown
  shares?: unknown
}

function parsedRecordFile(value: unknown): ParsedArtifactShareRecordFile {
  if (!value || typeof value !== 'object') {
    return {}
  }
  return {
    version: 'version' in value ? value.version : undefined,
    lifecycleGeneration: 'lifecycleGeneration' in value ? value.lifecycleGeneration : undefined,
    lifecycleNonce: 'lifecycleNonce' in value ? value.lifecycleNonce : undefined,
    shares: 'shares' in value ? value.shares : undefined
  }
}

export type PreserveExpired = { sourceKey: string; slug: string; editToken: string }

// Reads that dropped rows (expired or invalid) the file still holds.
export const artifactSharesPrunedOnRead = new WeakSet<ArtifactShareRecordFile>()

export function parseArtifactShareRecordFile(
  text: string | undefined,
  preserveExpired: PreserveExpired | undefined,
  pruneExpired: boolean
): ArtifactShareRecordFile {
  if (text === undefined) {
    return { version: 2, lifecycleGeneration: 0, lifecycleNonce: '', shares: {} }
  }
  let parsed: ParsedArtifactShareRecordFile
  try {
    parsed = parsedRecordFile(JSON.parse(text))
  } catch (error) {
    throw new Error('Artifact share records could not be read safely.', { cause: error })
  }
  if (parsed.version === 1) {
    return { version: 2, lifecycleGeneration: 0, lifecycleNonce: '', shares: {} }
  }
  if (
    parsed.version !== 2 ||
    !parsed.shares ||
    typeof parsed.shares !== 'object' ||
    Array.isArray(parsed.shares)
  ) {
    throw new Error('Artifact share records have an unsupported format.')
  }
  const shareEntries: [string, unknown][] = Object.entries(parsed.shares)
  const validShares = Object.fromEntries(
    shareEntries.filter((entry): entry is [string, ArtifactShareRecord] =>
      isArtifactShareRecord(entry[1])
    )
  )
  const pruned = pruneExpired
    ? pruneRecords(validShares, Date.now(), preserveExpired)
    : { shares: validShares, changed: false }
  const records: ArtifactShareRecordFile = {
    version: 2,
    lifecycleGeneration:
      Number.isSafeInteger(parsed.lifecycleGeneration) && Number(parsed.lifecycleGeneration) >= 0
        ? Number(parsed.lifecycleGeneration)
        : 0,
    lifecycleNonce: typeof parsed.lifecycleNonce === 'string' ? parsed.lifecycleNonce : '',
    shares: pruned.shares
  }
  if (pruned.changed || shareEntries.length !== Object.keys(validShares).length) {
    artifactSharesPrunedOnRead.add(records)
  }
  return records
}
