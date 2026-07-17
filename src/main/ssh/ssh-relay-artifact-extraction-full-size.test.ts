import { readFile, rm, stat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

import { describe, expect, it } from 'vitest'

import {
  extractSshRelayArtifact,
  SSH_RELAY_ARTIFACT_EXTRACTION_LIMITS
} from './ssh-relay-artifact-extraction'
import type { SshRelaySelectedArtifact } from './ssh-relay-artifact-selector'

type MeasurementIdentity = {
  tupleId: SshRelaySelectedArtifact['tupleId']
  contentId: SshRelaySelectedArtifact['contentId']
  os: SshRelaySelectedArtifact['tuple']['os']
  archive: SshRelaySelectedArtifact['tuple']['archive']
  entries: SshRelaySelectedArtifact['tuple']['entries']
}

const archivePath = process.env.ORCA_SSH_RELAY_FULL_SIZE_ARCHIVE
const identityPath = process.env.ORCA_SSH_RELAY_FULL_SIZE_IDENTITY
const outputDirectory = process.env.ORCA_SSH_RELAY_FULL_SIZE_OUTPUT
const hasMeasurementInput = Boolean(archivePath && identityPath && outputDirectory)

function measurementIdentity(input: unknown): MeasurementIdentity {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('tupleId' in input) ||
    !('contentId' in input) ||
    !('os' in input) ||
    !('archive' in input) ||
    !('entries' in input) ||
    !Array.isArray(input.entries)
  ) {
    throw new Error('Full-size extraction measurement identity is incomplete')
  }
  return input as MeasurementIdentity
}

function measurementArtifact(identity: MeasurementIdentity): SshRelaySelectedArtifact {
  const tuple = identity as unknown as SshRelaySelectedArtifact['tuple']
  // Why: this runner measures exact Actions artifact resources; it is never a product trust bypass.
  return Object.freeze({
    kind: 'selected',
    tupleId: identity.tupleId,
    contentId: identity.contentId,
    releaseTag: 'measurement-only',
    archive: Object.freeze({
      ...identity.archive,
      downloadUrl: 'https://invalid.example/measurement-only'
    }),
    tuple
  })
}

describe.skipIf(!hasMeasurementInput)('SSH relay full-size artifact extraction', () => {
  it(
    'stays within the desktop time and incremental-memory budgets',
    async () => {
      const identity = measurementIdentity(
        JSON.parse(await readFile(identityPath as string, 'utf8')) as unknown
      )
      await expect(stat(outputDirectory as string)).rejects.toMatchObject({ code: 'ENOENT' })
      const baselineRss = process.memoryUsage().rss
      let peakRss = baselineRss
      const sample = (): void => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss)
      }
      const sampler = setInterval(sample, 1)
      const startedAt = performance.now()
      let result
      try {
        result = await extractSshRelayArtifact({
          artifact: measurementArtifact(identity),
          archivePath: archivePath as string,
          outputDirectory: outputDirectory as string
        })
      } finally {
        clearInterval(sampler)
        sample()
      }
      const elapsedMs = performance.now() - startedAt
      const incrementalRssBytes = Math.max(0, peakRss - baselineRss)
      console.log(
        `ssh_relay_full_size_extraction=${JSON.stringify({
          tupleId: identity.tupleId,
          archiveBytes: identity.archive.size,
          expandedBytes: identity.archive.expandedSize,
          files: identity.archive.fileCount,
          elapsedMs,
          baselineRss,
          peakRss,
          incrementalRssBytes
        })}`
      )
      try {
        expect(result).toMatchObject({
          tupleId: identity.tupleId,
          contentId: identity.contentId,
          files: identity.archive.fileCount,
          expandedBytes: identity.archive.expandedSize
        })
        expect(elapsedMs).toBeLessThanOrEqual(SSH_RELAY_ARTIFACT_EXTRACTION_LIMITS.timeoutMs)
        expect(incrementalRssBytes).toBeLessThanOrEqual(
          SSH_RELAY_ARTIFACT_EXTRACTION_LIMITS.maximumIncrementalMemoryBytes
        )
      } finally {
        await rm(outputDirectory as string, { recursive: true })
      }
    },
    SSH_RELAY_ARTIFACT_EXTRACTION_LIMITS.timeoutMs + 10_000
  )
})
