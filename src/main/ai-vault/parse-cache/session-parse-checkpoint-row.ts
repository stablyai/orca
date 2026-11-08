import { z } from 'zod'
import { mergeSkippedTranscriptRecords } from '../transcripts/session-transcript-record-budget'
import type { SessionParseCheckpoint } from './session-parse-cache-store'

const checkpointSchema = z
  .object({
    parserKind: z.string().min(1),
    snapshotVersion: z.number().int().positive(),
    byteOffset: z.number().int().nonnegative(),
    mtimeMs: z.number(),
    sizeBytes: z.number().int().nonnegative().nullable(),
    fileIdentity: z
      .object({ dev: z.number().nonnegative(), ino: z.number().nonnegative() })
      .nullable(),
    sampleHash: z.string().regex(/^[0-9a-f]{64}$/),
    skippedRecords: z.array(
      z.object({
        byteOffset: z.number().int().nonnegative(),
        approximateBytes: z.number().int().positive()
      })
    ),
    snapshot: z.unknown()
  })
  .refine(
    (value) =>
      value.snapshot !== undefined &&
      (value.sizeBytes === null || value.byteOffset <= value.sizeBytes)
  )

/** Validate the envelope before the owning parser validates its versioned state payload. */
export function parsePersistedCheckpoint(value: unknown): SessionParseCheckpoint | undefined {
  const parsed = checkpointSchema.safeParse(value)
  if (!parsed.success) {
    return undefined
  }
  return {
    ...parsed.data,
    skippedRecords: mergeSkippedTranscriptRecords([], parsed.data.skippedRecords)
  }
}
