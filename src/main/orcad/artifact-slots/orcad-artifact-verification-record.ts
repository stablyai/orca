// Reuse digests only while device/inode/size/mtime/ctime match; changed files must be rehashed.
import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

// Cache retention ignores dot-prefixed records.
export const ORCAD_ARTIFACT_VERIFICATION_RECORD_FILENAME = '.verified-sources.json'

// Coarse filesystem clocks can hide rapid edits; recently changed files must be rehashed.
const SETTLED_AFTER_MS = 2_000n

const SignedFileSchema = z.object({
  filename: z.string(),
  signature: z.string().min(1)
})

const RecordSchema = z.object({
  version: z.literal(1),
  contentDigest: z.string().regex(/^[a-f0-9]{12}$/u),
  sources: z.array(
    SignedFileSchema.extend({
      path: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u)
    })
  ),
  slot: z.object({ path: z.string(), files: z.array(SignedFileSchema) }).nullable()
})

export type OrcadArtifactVerificationRecord = z.infer<typeof RecordSchema>

type FileSignature = {
  signature: string
  /** Recent edits may not yet yield stable timestamps. */
  settled: boolean
}

export async function fileSignature(path: string, nowMs: number): Promise<FileSignature | null> {
  try {
    const info = await stat(path, { bigint: true })
    if (!info.isFile()) {
      return null
    }
    const settledBefore = (BigInt(Math.floor(nowMs)) - SETTLED_AFTER_MS) * 1_000_000n
    return {
      signature: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
      settled: info.mtimeNs < settledBefore && info.ctimeNs < settledBefore
    }
  } catch {
    return null
  }
}

export async function readOrcadArtifactVerificationRecord(
  targetRoot: string
): Promise<OrcadArtifactVerificationRecord | null> {
  try {
    const raw = await readFile(
      join(targetRoot, ORCAD_ARTIFACT_VERIFICATION_RECORD_FILENAME),
      'utf8'
    )
    const parsed = RecordSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Failed writes only cost a full hash on the next launch. */
export async function writeOrcadArtifactVerificationRecord(
  targetRoot: string,
  record: OrcadArtifactVerificationRecord
): Promise<void> {
  const destination = join(targetRoot, ORCAD_ARTIFACT_VERIFICATION_RECORD_FILENAME)
  const temporary = `${destination}.${process.pid}-${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
    await rename(temporary, destination)
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}
