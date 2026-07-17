import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SshRelayArtifactCacheEntry } from './ssh-relay-artifact-cache-entry-verification'
import type { SshRelayDigest } from './ssh-relay-runtime-identity'

export function sshRelayArtifactCacheEvictionContentId(character: string): SshRelayDigest {
  return `sha256:${character.repeat(64)}` as SshRelayDigest
}

export async function createSshRelayArtifactCacheEvictionFixture({
  cacheRoot,
  character,
  payloadBytes = 32
}: {
  cacheRoot: string
  character: string
  payloadBytes?: number
}): Promise<{ entry: SshRelayArtifactCacheEntry; logicalBytes: number }> {
  const contentId = sshRelayArtifactCacheEvictionContentId(character)
  const entryPath = join(cacheRoot, 'entries', contentId.slice('sha256:'.length))
  const runtimeRoot = join(entryPath, 'runtime')
  const archivePath = join(entryPath, 'runtime.tar.br')
  const proofPath = join(entryPath, 'proof.json')
  const archive = Buffer.alloc(payloadBytes, character)
  const runtime = Buffer.alloc(payloadBytes + 1, character)
  const proof = Buffer.from('{}\n')
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 })
  await writeFile(archivePath, archive, { mode: 0o600 })
  await writeFile(join(runtimeRoot, 'relay.js'), runtime, { mode: 0o700 })
  await writeFile(proofPath, proof, { mode: 0o600 })
  return {
    entry: {
      contentId,
      tupleId: 'linux-x64-glibc',
      entryPath,
      archivePath,
      runtimeRoot,
      proofPath,
      files: 1,
      expandedBytes: runtime.length
    },
    logicalBytes: archive.length + runtime.length + proof.length
  }
}
