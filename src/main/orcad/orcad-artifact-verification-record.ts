/**
 * Remembers which template and cache-slot files were last hashed, by their stat identity, so a
 * relaunch reuses those digests instead of re-reading ~tens of MB. Any change to a file's device,
 * inode, size, mtime or ctime (an app update, a repair, an in-place edit) falls back to hashing.
 */
import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

/** Dot-prefixed so cache retention, which only evicts slot directories, never reads it. */
export const ORCAD_ARTIFACT_VERIFICATION_RECORD_FILENAME = '.verified-sources.json'

/**
 * A file changed within this window of its signature being taken may change again without its
 * timestamps moving (coarse filesystem clocks), so it is hashed rather than remembered.
 */
const SETTLED_AFTER_MS = 2_000n

const SignedFileSchema = z.object({
  filename: z.string(),
  signature: z.string().min(1)
})

const RecordSchema = z.object({
  version: z.literal(1),
  /** The combined content digest that names the slot (`<orcad version>+<digest>`). */
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

export type FileSignature = {
  signature: string
  /** False when the file changed too recently for its signature to prove it unchanged later. */
  settled: boolean
}

/** Stat identity of a regular file, or null when it is missing or not a file. */
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

/** Best effort: a lost write only costs the next launch a full hash. */
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
