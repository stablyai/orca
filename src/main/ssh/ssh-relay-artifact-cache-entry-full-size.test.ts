import { readFile, rm, stat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

import { describe, expect, it } from 'vitest'

import {
  lookupSshRelayArtifactCacheEntry,
  publishSshRelayArtifactCacheEntry,
  SSH_RELAY_ARTIFACT_CACHE_ENTRY_LIMITS
} from './ssh-relay-artifact-cache-entry'
import {
  evictSshRelayArtifactCache,
  SSH_RELAY_ARTIFACT_CACHE_EVICTION_LIMITS
} from './ssh-relay-artifact-cache-eviction'
import {
  acquireSshRelayArtifactCacheInUseLease,
  SSH_RELAY_ARTIFACT_CACHE_IN_USE_LIMITS
} from './ssh-relay-artifact-cache-in-use-lease'
import type { SshRelaySelectedArtifact } from './ssh-relay-artifact-selector'
import {
  scanSshRelayRuntimeSourceTree,
  SSH_RELAY_RUNTIME_SOURCE_SCAN_LIMITS
} from './ssh-relay-runtime-source-scan'
import {
  streamSshRelayRuntimeSourceTree,
  SSH_RELAY_RUNTIME_SOURCE_STREAM_LIMITS
} from './ssh-relay-runtime-source-stream'
import { createSshRelayRuntimeSourceTree } from './ssh-relay-runtime-source-tree'

type MeasurementIdentity = {
  tupleId: SshRelaySelectedArtifact['tupleId']
  contentId: SshRelaySelectedArtifact['contentId']
  os: SshRelaySelectedArtifact['tuple']['os']
  archive: SshRelaySelectedArtifact['tuple']['archive']
  entries: SshRelaySelectedArtifact['tuple']['entries']
}

const archivePath = process.env.ORCA_SSH_RELAY_FULL_SIZE_ARCHIVE
const identityPath = process.env.ORCA_SSH_RELAY_FULL_SIZE_IDENTITY
const cacheRoot = process.env.ORCA_SSH_RELAY_FULL_SIZE_OUTPUT
const hasMeasurementInput = Boolean(archivePath && identityPath && cacheRoot)

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
    throw new Error('Full-size cache measurement identity is incomplete')
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

async function measure<T>(operation: () => Promise<T>): Promise<{
  result: T
  elapsedMs: number
  baselineRss: number
  peakRss: number
  incrementalRssBytes: number
}> {
  const baselineRss = process.memoryUsage().rss
  let peakRss = baselineRss
  const sample = (): void => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }
  const sampler = setInterval(sample, 1)
  const startedAt = performance.now()
  let result: T
  try {
    result = await operation()
  } finally {
    clearInterval(sampler)
    sample()
  }
  return {
    result,
    elapsedMs: performance.now() - startedAt,
    baselineRss,
    peakRss,
    incrementalRssBytes: Math.max(0, peakRss - baselineRss)
  }
}

describe.skipIf(!hasMeasurementInput)('SSH relay full-size immutable artifact cache entry', () => {
  it(
    'keeps cold publication, verified lookup, active retention, and eviction within budgets',
    async () => {
      const identity = measurementIdentity(
        JSON.parse(await readFile(identityPath as string, 'utf8')) as unknown
      )
      const artifact = measurementArtifact(identity)
      await expect(stat(cacheRoot as string)).rejects.toMatchObject({ code: 'ENOENT' })
      try {
        const cold = await measure(() =>
          publishSshRelayArtifactCacheEntry({
            cacheRoot: cacheRoot as string,
            artifact,
            archivePath: archivePath as string
          })
        )
        const warm = await measure(() =>
          lookupSshRelayArtifactCacheEntry({ cacheRoot: cacheRoot as string, artifact })
        )
        if (warm.result.kind !== 'hit') {
          throw new Error('Full-size cache entry unexpectedly missed after cold publication')
        }
        const warmEntry = warm.result.entry
        const lease = await acquireSshRelayArtifactCacheInUseLease({
          cacheRoot: cacheRoot as string,
          entry: warmEntry
        })
        const { scan, stream, retained } = await (async () => {
          try {
            const sourceTree = createSshRelayRuntimeSourceTree({
              kind: 'ready',
              source: 'cache',
              artifact,
              entry: warmEntry,
              lease
            })
            const scan = await measure(() =>
              scanSshRelayRuntimeSourceTree(sourceTree, new AbortController().signal)
            )
            const stream = await measure(() =>
              streamSshRelayRuntimeSourceTree({
                tree: scan.result,
                signal: new AbortController().signal,
                maximumConcurrency: 4,
                openDestination: async () => ({
                  write: async () => {},
                  close: async () => {},
                  abort: async () => {}
                })
              })
            )
            const retained = await measure(() =>
              evictSshRelayArtifactCache({ cacheRoot: cacheRoot as string, maximumBytes: 0 })
            )
            return { scan, stream, retained }
          } finally {
            await lease.release()
          }
        })()
        const eviction = await measure(() =>
          evictSshRelayArtifactCache({ cacheRoot: cacheRoot as string, maximumBytes: 0 })
        )
        console.log(
          `ssh_relay_full_size_cache=${JSON.stringify({
            tupleId: identity.tupleId,
            archiveBytes: identity.archive.size,
            expandedBytes: identity.archive.expandedSize,
            files: identity.archive.fileCount,
            coldElapsedMs: cold.elapsedMs,
            coldIncrementalRssBytes: cold.incrementalRssBytes,
            warmElapsedMs: warm.elapsedMs,
            warmIncrementalRssBytes: warm.incrementalRssBytes,
            scanElapsedMs: scan.elapsedMs,
            scanIncrementalRssBytes: scan.incrementalRssBytes,
            streamElapsedMs: stream.elapsedMs,
            streamIncrementalRssBytes: stream.incrementalRssBytes,
            retainedElapsedMs: retained.elapsedMs,
            retainedIncrementalRssBytes: retained.incrementalRssBytes,
            evictionElapsedMs: eviction.elapsedMs,
            evictionIncrementalRssBytes: eviction.incrementalRssBytes,
            evictionInitialBytes: eviction.result.initialBytes,
            evictionReclaimedBytes: eviction.result.reclaimedBytes
          })}`
        )
        expect(cold.result).toMatchObject({
          tupleId: identity.tupleId,
          contentId: identity.contentId,
          files: identity.archive.fileCount,
          expandedBytes: identity.archive.expandedSize
        })
        expect(warm.result).toEqual({ kind: 'hit', entry: cold.result })
        expect(scan.result).toMatchObject({
          tupleId: identity.tupleId,
          contentId: identity.contentId,
          fileCount: identity.archive.fileCount,
          expandedBytes: identity.archive.expandedSize
        })
        expect(stream.result).toEqual({
          tupleId: identity.tupleId,
          contentId: identity.contentId,
          filesCompleted: identity.archive.fileCount,
          totalFiles: identity.archive.fileCount,
          bytesTransferred: identity.archive.expandedSize,
          totalBytes: identity.archive.expandedSize
        })
        expect(retained.result).toMatchObject({
          initialBytes: expect.any(Number),
          finalBytes: expect.any(Number),
          reclaimedBytes: 0,
          evictedContentIds: [],
          blockedContentIds: [identity.contentId],
          accountingComplete: true
        })
        expect(retained.result.initialBytes).toBeGreaterThan(0)
        expect(retained.result.finalBytes).toBe(retained.result.initialBytes)
        expect(eviction.result).toEqual({
          initialBytes: retained.result.initialBytes,
          finalBytes: 0,
          reclaimedBytes: retained.result.initialBytes,
          evictedContentIds: [identity.contentId],
          blockedContentIds: [],
          accountingComplete: true
        })
        await expect(stat(cold.result.entryPath)).rejects.toMatchObject({ code: 'ENOENT' })
        for (const measurement of [cold, warm]) {
          expect(measurement.elapsedMs).toBeLessThanOrEqual(
            SSH_RELAY_ARTIFACT_CACHE_ENTRY_LIMITS.transactionTimeoutMs
          )
          expect(measurement.incrementalRssBytes).toBeLessThanOrEqual(
            SSH_RELAY_ARTIFACT_CACHE_ENTRY_LIMITS.maximumIncrementalMemoryBytes
          )
        }
        expect(scan.elapsedMs).toBeLessThanOrEqual(
          SSH_RELAY_RUNTIME_SOURCE_SCAN_LIMITS.measurementTimeoutMs
        )
        expect(scan.incrementalRssBytes).toBeLessThanOrEqual(
          SSH_RELAY_RUNTIME_SOURCE_SCAN_LIMITS.maximumIncrementalMemoryBytes
        )
        expect(stream.elapsedMs).toBeLessThanOrEqual(
          SSH_RELAY_RUNTIME_SOURCE_STREAM_LIMITS.measurementTimeoutMs
        )
        expect(stream.incrementalRssBytes).toBeLessThanOrEqual(
          SSH_RELAY_RUNTIME_SOURCE_STREAM_LIMITS.maximumIncrementalMemoryBytes
        )
        for (const measurement of [retained, eviction]) {
          expect(measurement.elapsedMs).toBeLessThanOrEqual(
            SSH_RELAY_ARTIFACT_CACHE_EVICTION_LIMITS.transactionTimeoutMs
          )
          expect(measurement.incrementalRssBytes).toBeLessThanOrEqual(
            SSH_RELAY_ARTIFACT_CACHE_ENTRY_LIMITS.maximumIncrementalMemoryBytes
          )
        }
      } finally {
        await rm(cacheRoot as string, { recursive: true, force: true })
      }
    },
    SSH_RELAY_ARTIFACT_CACHE_ENTRY_LIMITS.transactionTimeoutMs * 2 +
      SSH_RELAY_ARTIFACT_CACHE_EVICTION_LIMITS.transactionTimeoutMs * 2 +
      SSH_RELAY_ARTIFACT_CACHE_IN_USE_LIMITS.acquisitionTimeoutMs +
      10_000
  )
})
