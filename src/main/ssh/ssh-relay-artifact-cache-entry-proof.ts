import { z } from 'zod'

import type { SshRelaySelectedArtifact } from './ssh-relay-artifact-selector'

export const SSH_RELAY_ARTIFACT_CACHE_ENTRY_PROOF_NAME = 'proof.json'
export const SSH_RELAY_ARTIFACT_CACHE_ENTRY_PROOF_MAX_BYTES = 16 * 1024

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const safeSizeSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const proofSchema = z
  .object({
    schemaVersion: z.literal(1),
    tupleId: z.string().min(1).max(64),
    contentId: digestSchema,
    releaseTag: z.string().min(1).max(128),
    archive: z
      .object({
        name: z.string().regex(/^[A-Za-z0-9._-]+$/),
        size: safeSizeSchema,
        sha256: digestSchema
      })
      .strict(),
    runtime: z.object({ files: safeSizeSchema, expandedBytes: safeSizeSchema }).strict()
  })
  .strict()

export type SshRelayArtifactCacheEntryProof = z.infer<typeof proofSchema>

export function createSshRelayArtifactCacheEntryProof(
  artifact: SshRelaySelectedArtifact,
  runtime: { files: number; expandedBytes: number }
): SshRelayArtifactCacheEntryProof {
  return {
    schemaVersion: 1,
    tupleId: artifact.tupleId,
    contentId: artifact.contentId,
    releaseTag: artifact.releaseTag,
    archive: {
      name: artifact.archive.name,
      size: artifact.archive.size,
      sha256: artifact.archive.sha256
    },
    runtime: { files: runtime.files, expandedBytes: runtime.expandedBytes }
  }
}

export function sshRelayArtifactCacheEntryProofBytes(
  proof: SshRelayArtifactCacheEntryProof
): Buffer {
  return Buffer.from(`${JSON.stringify(proof)}\n`, 'utf8')
}

export function parseSshRelayArtifactCacheEntryProof(
  bytes: Buffer,
  artifact: SshRelaySelectedArtifact
): SshRelayArtifactCacheEntryProof {
  let input: unknown
  try {
    input = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error('SSH relay artifact cache proof is not valid JSON', { cause: error })
  }
  const proof = proofSchema.parse(input)
  const expected = createSshRelayArtifactCacheEntryProof(artifact, {
    files: artifact.archive.fileCount,
    expandedBytes: artifact.archive.expandedSize
  })
  if (
    proof.tupleId !== expected.tupleId ||
    proof.contentId !== expected.contentId ||
    proof.releaseTag !== expected.releaseTag ||
    proof.archive.name !== expected.archive.name ||
    proof.archive.size !== expected.archive.size ||
    proof.archive.sha256 !== expected.archive.sha256 ||
    proof.runtime.files !== expected.runtime.files ||
    proof.runtime.expandedBytes !== expected.runtime.expandedBytes
  ) {
    throw new Error('SSH relay artifact cache proof disagrees with the selected signed artifact')
  }
  return proof
}
