/** Hashes or, when unchanged since last hashed, recalls the orcad template and slot files. */
import { createHash, type Hash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ORCAD_VERSION, ORCAD_VERSION_FILENAME } from '../../shared/orcad-artifacts'
import {
  fileSignature,
  writeOrcadArtifactVerificationRecord,
  type OrcadArtifactVerificationRecord
} from './orcad-artifact-verification-record'
import { fileSha256 } from '../node-runtime/pinned-runtime-materializer'

export type ArtifactSource = { filename: string; path: string; executable?: boolean }
export type ExpectedSha256 = { sha256: string; label: string }
type SignedSource = OrcadArtifactVerificationRecord['sources'][number]
type RecordedSlot = NonNullable<OrcadArtifactVerificationRecord['slot']>
type ArtifactIdentity = {
  fullVersion: string
  contentDigest: string
  sourceHashes: Map<string, string>
  /** Null when a source changed too recently for its signature to be remembered. */
  signed: SignedSource[] | null
}

/**
 * One read of each source yields both its manifest check and the slot identity. A recorded
 * verification is reused only while every source keeps the stat signature it was hashed at.
 */
export async function verifiedArtifactIdentity(
  sources: ArtifactSource[],
  expected: Map<string, ExpectedSha256>,
  record: OrcadArtifactVerificationRecord | null,
  nowMs: number,
  /** Off for callers that never keep a record, so they pay no stat calls. */
  sign = true
): Promise<ArtifactIdentity> {
  const signatures = sign
    ? await Promise.all(sources.map((source) => fileSignature(source.path, nowMs)))
    : sources.map(() => null)
  const reusable =
    record !== null &&
    record.sources.length === sources.length &&
    sources.every((source, index) => {
      const entry = record.sources[index]
      const signature = signatures[index]
      return (
        entry?.filename === source.filename &&
        entry.path === source.path &&
        signature?.settled === true &&
        entry.signature === signature.signature &&
        entry.sha256 === expected.get(source.filename)?.sha256
      )
    })
  if (record && reusable) {
    return {
      fullVersion: `${ORCAD_VERSION}+${record.contentDigest}`,
      contentDigest: record.contentDigest,
      sourceHashes: new Map(record.sources.map((entry) => [entry.filename, entry.sha256])),
      signed: record.sources
    }
  }
  const combined = createHash('sha256')
  const sourceHashes = new Map<string, string>()
  const signed: SignedSource[] = []
  for (const [index, source] of sources.entries()) {
    const want = expected.get(source.filename)
    if (!want) {
      throw new Error(`Packaged orcad template manifest omits ${source.filename}`)
    }
    const actual = await hashSourceInto(source.path, combined)
    if (actual !== want.sha256) {
      throw new Error(
        `${want.label} checksum mismatch: expected ${want.sha256}, got ${actual ?? 'missing'}`
      )
    }
    sourceHashes.set(source.filename, actual)
    const signature = signatures[index]
    if (signature?.settled) {
      signed.push({
        filename: source.filename,
        path: source.path,
        signature: signature.signature,
        sha256: actual
      })
    }
  }
  const contentDigest = combined.digest('hex').slice(0, 12)
  return {
    fullVersion: `${ORCAD_VERSION}+${contentDigest}`,
    contentDigest,
    sourceHashes,
    signed: signed.length === sources.length ? signed : null
  }
}

/** The file's own digest, also fed into `combined`; null when it cannot be read. */
async function hashSourceInto(path: string, combined: Hash): Promise<string | null> {
  const own = createHash('sha256')
  try {
    for await (const chunk of createReadStream(path)) {
      combined.update(chunk)
      own.update(chunk)
    }
  } catch {
    return null
  }
  return own.digest('hex')
}

export function sameHashes(
  record: OrcadArtifactVerificationRecord,
  sourceHashes: Map<string, string>
): boolean {
  return (
    record.sources.length === sourceHashes.size &&
    record.sources.every((entry) => sourceHashes.get(entry.filename) === entry.sha256)
  )
}

/** The slot was hashed against these same sources and none of its files changed since. */
export async function slotMatchesRecord(
  dir: string,
  fullVersion: string,
  sources: ArtifactSource[],
  recorded: RecordedSlot | null,
  nowMs: number
): Promise<boolean> {
  if (recorded?.path !== dir || recorded.files.length !== sources.length) {
    return false
  }
  try {
    if ((await readFile(join(dir, ORCAD_VERSION_FILENAME), 'utf8')).trim() !== fullVersion) {
      return false
    }
  } catch {
    return false
  }
  const signatures = await Promise.all(
    sources.map((source) => fileSignature(join(dir, source.filename), nowMs))
  )
  return sources.every((source, index) => {
    const entry = recorded.files[index]
    const signature = signatures[index]
    return (
      entry?.filename === source.filename &&
      signature?.settled === true &&
      entry.signature === signature.signature
    )
  })
}

export async function signSlot(
  dir: string,
  sources: ArtifactSource[],
  nowMs: number
): Promise<RecordedSlot | null> {
  const signatures = await Promise.all(
    sources.map((source) => fileSignature(join(dir, source.filename), nowMs))
  )
  const files: RecordedSlot['files'] = []
  for (const [index, source] of sources.entries()) {
    const signature = signatures[index]
    if (!signature?.settled) {
      return null
    }
    files.push({ filename: source.filename, signature: signature.signature })
  }
  return { path: dir, files }
}

export async function rememberVerification(
  targetRoot: string,
  previous: OrcadArtifactVerificationRecord | null,
  identity: ArtifactIdentity,
  slot: RecordedSlot | null
): Promise<void> {
  if (!identity.signed) {
    return
  }
  const next: OrcadArtifactVerificationRecord = {
    version: 1,
    contentDigest: identity.contentDigest,
    sources: identity.signed,
    slot
  }
  if (previous && JSON.stringify(previous) === JSON.stringify(next)) {
    return
  }
  await writeOrcadArtifactVerificationRecord(targetRoot, next)
}

export async function isCompleteArtifact(
  dir: string,
  fullVersion: string,
  sources: { filename: string }[],
  sourceHashes: Map<string, string>
): Promise<boolean> {
  try {
    if ((await readFile(join(dir, ORCAD_VERSION_FILENAME), 'utf8')).trim() !== fullVersion) {
      return false
    }
    for (const source of sources) {
      if ((await fileSha256(join(dir, source.filename))) !== sourceHashes.get(source.filename)) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}
