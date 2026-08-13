import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  CURSOR_REMOTE_MAX_AGGREGATE_BYTES,
  CURSOR_SIDECAR_MAX_BYTES
} from '../../shared/cursor-sidecar-scan'
import { startSpan } from '../observability/tracer'
import { processLocalCursorCandidates } from './session-scanner-cursor-local-pipeline'
import * as cursorSidecarParser from './session-scanner-cursor-sidecar'
import { createSessionParseStats } from './session-scanner-parse-cache'
import type {
  FileWithMtime,
  SessionFileCandidate,
  SessionFileDiscovery
} from './session-scanner-types'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  cursorSidecarParser.resetCursorSidecarParseCacheForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Cursor verified-read budgets by storage context', () => {
  it.each(['native', 'wsl:ubuntu'])(
    'keeps eight cold %s verified reads concurrent within one storage budget',
    async (storageKey) => {
      const root = await mkdtemp(join(tmpdir(), 'orca-cursor-storage-concurrency-'))
      roots.push(root)
      const chatsRoot = join(root, '.cursor', 'chats')
      const files = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          addSession(chatsRoot, `session-${index}`, sidecarPayload(1_000), 1_000)
        )
      )
      const discovery = sidecarDiscovery(storageKey, chatsRoot, await realpath(chatsRoot), files)
      const originalParse = cursorSidecarParser.parseCursorSidecarFileCached
      let activeReads = 0
      let peakReads = 0
      vi.spyOn(cursorSidecarParser, 'parseCursorSidecarFileCached').mockImplementation(
        async (args) => {
          activeReads += 1
          peakReads = Math.max(peakReads, activeReads)
          await new Promise<void>((resolve) => setImmediate(resolve))
          try {
            return await originalParse(args)
          } finally {
            activeReads -= 1
          }
        }
      )
      const span = startSpan('cursor-storage-concurrency-test')

      try {
        const result = await processLocalCursorCandidates({
          candidates: discoveryCandidates(discovery),
          discoveries: [discovery],
          executionHostId: 'local',
          issues: [],
          limit: 20,
          parseStats: createSessionParseStats(),
          platform: 'linux',
          scopeLimit: 20,
          span
        })

        expect(result.sessions).toHaveLength(8)
        expect(peakReads).toBe(8)
        expect(discovery.cursorDiscoveryCounters?.boundedReads).toBe(8)
      } finally {
        span.end()
      }
    }
  )

  it.each(['native', 'wsl:ubuntu'])(
    'waits for temporary %s reservations when the statted batch still fits',
    async (storageKey) => {
      const root = await mkdtemp(join(tmpdir(), 'orca-cursor-storage-reservations-'))
      roots.push(root)
      const chatsRoot = join(root, '.cursor', 'chats')
      const fillerBytes = CURSOR_SIDECAR_MAX_BYTES - 100
      const fillerFiles = await Promise.all(
        Array.from({ length: 63 }, (_, index) =>
          addSession(
            chatsRoot,
            `filler-${String(index).padStart(2, '0')}`,
            sidecarPayload(fillerBytes),
            10_000
          )
        )
      )
      const tailFiles = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          addSession(chatsRoot, `tail-${index}`, sidecarPayload(1_000), 1_000)
        )
      )
      const files = [...fillerFiles, ...tailFiles]
      const discovery = sidecarDiscovery(storageKey, chatsRoot, await realpath(chatsRoot), files)
      const span = startSpan('cursor-storage-reservation-wait-test')

      try {
        const result = await processLocalCursorCandidates({
          candidates: discoveryCandidates(discovery),
          discoveries: [discovery],
          executionHostId: 'local',
          issues: [],
          limit: 100,
          parseStats: createSessionParseStats(),
          platform: 'linux',
          scopeLimit: 100,
          span
        })

        expect(result.sessions).toHaveLength(files.length)
        expect(discovery.cursorDiscoveryCounters?.boundedReads).toBe(files.length)
        expect(discovery.cursorDiscoveryCounters?.returnedBytes).toBe(63 * fillerBytes + 8_000)
        expect(discovery.cursorDiscoveryTruncated?.sidecarBytes).toBe(false)
      } finally {
        span.end()
      }
    },
    30_000
  )

  it('stops after the first verified read when cancellation lands during parsing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-cursor-parse-cancel-'))
    roots.push(root)
    const chatsRoot = join(root, '.cursor', 'chats')
    const files = await Promise.all([
      addSession(chatsRoot, 'first-session', sidecarPayload(5_000), 2_000),
      addSession(chatsRoot, 'second-session', sidecarPayload(5_000), 1_000)
    ])
    const discovery = sidecarDiscovery('native', chatsRoot, await realpath(chatsRoot), files)
    let cancellationChecks = 0
    const signal = {
      get aborted() {
        cancellationChecks += 1
        return cancellationChecks > 1
      }
    } as AbortSignal
    const span = startSpan('cursor-parse-cancel-test')

    try {
      await expect(
        processLocalCursorCandidates({
          candidates: discoveryCandidates(discovery),
          discoveries: [discovery],
          executionHostId: 'local',
          issues: [],
          limit: 20,
          parseStats: createSessionParseStats(),
          platform: 'linux',
          scopeLimit: 20,
          signal,
          span
        })
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(discovery.cursorDiscoveryCounters?.boundedReads).toBe(1)
    } finally {
      span.end()
    }
  })

  it('bounds a raced verified read by the remaining aggregate budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-cursor-storage-race-'))
    roots.push(root)
    const chatsRoot = join(root, '.cursor', 'chats')
    const fillerBytes = CURSOR_SIDECAR_MAX_BYTES - 100
    const fillerCount = Math.floor(CURSOR_REMOTE_MAX_AGGREGATE_BYTES / fillerBytes)
    const fillerFiles: FileWithMtime[] = []
    for (let index = 0; index < fillerCount; index += 1) {
      fillerFiles.push(
        await addSession(
          chatsRoot,
          `filler-${String(index).padStart(3, '0')}`,
          sidecarPayload(fillerBytes),
          10_000
        )
      )
    }
    const racedFiles = await Promise.all([
      addSession(chatsRoot, 'race-first', sidecarPayload(1_000), 2_000),
      addSession(chatsRoot, 'race-second', sidecarPayload(1_000), 1_000)
    ])
    const racedBytes = 8_000
    await Promise.all(racedFiles.map((file) => writeFile(file.path, sidecarPayload(racedBytes))))
    const files = [...fillerFiles, ...racedFiles]
    const discovery = sidecarDiscovery('native', chatsRoot, await realpath(chatsRoot), files)
    const span = startSpan('cursor-storage-race-test')
    const issues: AiVaultScanIssue[] = []

    try {
      const result = await processLocalCursorCandidates({
        candidates: discoveryCandidates(discovery),
        discoveries: [discovery],
        executionHostId: 'local',
        issues,
        limit: 100,
        parseStats: createSessionParseStats(),
        platform: 'linux',
        scopeLimit: 100,
        span
      })
      const fillerTotal = fillerBytes * fillerCount

      expect(result.sessions).toHaveLength(fillerCount)
      expect(discovery.cursorDiscoveryCounters?.boundedReads).toBe(fillerCount + 1)
      expect(discovery.cursorDiscoveryCounters?.returnedBytes).toBe(fillerTotal)
      expect(discovery.cursorDiscoveryCounters?.returnedBytes).toBeLessThanOrEqual(
        CURSOR_REMOTE_MAX_AGGREGATE_BYTES
      )
      expect(discovery.cursorDiscoveryTruncated?.sidecarBytes).toBe(true)
      expect(issues).toContainEqual(expect.objectContaining({ message: 'file_too_large' }))
    } finally {
      span.end()
    }
  }, 30_000)

  it('stops after a raced sidecar grows past the verified-read limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-cursor-storage-oversized-race-'))
    roots.push(root)
    const chatsRoot = join(root, '.cursor', 'chats')
    const files = await Promise.all([
      addSession(chatsRoot, 'race-first', sidecarPayload(1_000), 2_000),
      addSession(chatsRoot, 'race-second', sidecarPayload(1_000), 1_000)
    ])
    await Promise.all(
      files.map((file) => writeFile(file.path, sidecarPayload(CURSOR_SIDECAR_MAX_BYTES + 1)))
    )
    const discovery = sidecarDiscovery('native', chatsRoot, await realpath(chatsRoot), files)
    const span = startSpan('cursor-storage-oversized-race-test')
    const issues: AiVaultScanIssue[] = []

    try {
      const result = await processLocalCursorCandidates({
        candidates: discoveryCandidates(discovery),
        discoveries: [discovery],
        executionHostId: 'local',
        issues,
        limit: 20,
        parseStats: createSessionParseStats(),
        platform: 'linux',
        scopeLimit: 20,
        span
      })

      expect(result.sessions).toEqual([])
      expect(discovery.cursorDiscoveryCounters?.boundedReads).toBe(2)
      expect(discovery.cursorDiscoveryCounters?.returnedBytes).toBe(0)
      expect(discovery.cursorDiscoveryTruncated?.sidecarBytes).toBe(true)
      expect(issues).toHaveLength(2)
      expect(issues[0]?.message).toContain('file_too_large')
    } finally {
      span.end()
    }
  })

  it('prioritizes cancellation that lands during a failed raced read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-cursor-storage-cancelled-failure-'))
    roots.push(root)
    const chatsRoot = join(root, '.cursor', 'chats')
    const files = [await addSession(chatsRoot, 'race', sidecarPayload(1_000), 1_000)]
    await writeFile(files[0].path, sidecarPayload(CURSOR_SIDECAR_MAX_BYTES + 1))
    const discovery = sidecarDiscovery('native', chatsRoot, await realpath(chatsRoot), files)
    const span = startSpan('cursor-storage-cancelled-failure-test')
    let aborted = false
    const signal = {
      get aborted() {
        queueMicrotask(() => {
          aborted = true
        })
        return aborted
      }
    } as AbortSignal

    try {
      await expect(
        processLocalCursorCandidates({
          candidates: discoveryCandidates(discovery),
          discoveries: [discovery],
          executionHostId: 'local',
          issues: [],
          limit: 20,
          parseStats: createSessionParseStats(),
          platform: 'linux',
          scopeLimit: 20,
          signal,
          span
        })
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(discovery.cursorDiscoveryCounters?.boundedReads).toBe(1)
    } finally {
      span.end()
    }
  })

  it('caps generic failed read attempts without charging returned bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-cursor-storage-failed-reads-'))
    roots.push(root)
    const chatsRoot = join(root, '.cursor', 'chats')
    const attemptLimit = CURSOR_REMOTE_MAX_AGGREGATE_BYTES / CURSOR_SIDECAR_MAX_BYTES
    const files = await Promise.all(
      Array.from({ length: attemptLimit + 2 }, (_, index) =>
        addSession(chatsRoot, `failed-${index}`, sidecarPayload(1_000), 1_000)
      )
    )
    await Promise.all(
      files.map(async (file) => {
        await rm(file.path)
        await mkdir(file.path)
      })
    )
    const discovery = sidecarDiscovery('wsl:ubuntu', chatsRoot, await realpath(chatsRoot), files)
    const span = startSpan('cursor-storage-failed-reads-test')
    const issues: AiVaultScanIssue[] = []

    try {
      const result = await processLocalCursorCandidates({
        candidates: discoveryCandidates(discovery),
        discoveries: [discovery],
        executionHostId: 'local',
        issues,
        limit: 100,
        parseStats: createSessionParseStats(),
        platform: 'linux',
        scopeLimit: 100,
        span
      })

      expect(result.sessions).toEqual([])
      expect(discovery.cursorDiscoveryCounters?.boundedReads).toBe(attemptLimit)
      expect(discovery.cursorDiscoveryCounters?.returnedBytes).toBe(0)
      expect(discovery.cursorDiscoveryTruncated?.sidecarBytes).toBe(true)
      expect(issues).toHaveLength(attemptLimit)
      expect(issues[0]?.message).toContain('verified_file_not_regular')
    } finally {
      span.end()
    }
  })

  it('does not let native reads consume the WSL ingress budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-cursor-storage-budget-'))
    roots.push(root)
    const nativeRoot = join(root, 'native', '.cursor', 'chats')
    const wslRoot = join(root, 'wsl', '.cursor', 'chats')
    const nativePayloadBytes = CURSOR_SIDECAR_MAX_BYTES - 44
    const nativeFileCount = Math.floor(CURSOR_REMOTE_MAX_AGGREGATE_BYTES / nativePayloadBytes)
    const wslPayloadBytes = 5_000
    const nativePayload = sidecarPayload(nativePayloadBytes)
    const nativeFiles: FileWithMtime[] = []
    expect(nativePayloadBytes * nativeFileCount + wslPayloadBytes).toBeGreaterThan(
      CURSOR_REMOTE_MAX_AGGREGATE_BYTES
    )

    for (let index = 0; index < nativeFileCount; index += 1) {
      nativeFiles.push(
        await addSession(
          nativeRoot,
          `native-${String(index).padStart(3, '0')}`,
          nativePayload,
          10_000
        )
      )
    }
    const wslFile = await addSession(wslRoot, 'wsl-session', sidecarPayload(wslPayloadBytes), 1_000)
    const discoveries = [
      sidecarDiscovery('native', nativeRoot, await realpath(nativeRoot), nativeFiles),
      sidecarDiscovery('wsl:ubuntu', wslRoot, await realpath(wslRoot), [wslFile])
    ]
    const span = startSpan('cursor-storage-budget-test')
    const issues = []

    try {
      const result = await processLocalCursorCandidates({
        candidates: discoveries.flatMap(discoveryCandidates),
        discoveries,
        executionHostId: 'local',
        issues,
        limit: 100,
        parseStats: createSessionParseStats(),
        platform: 'linux',
        scopeLimit: 100,
        span
      })

      expect(issues).toEqual([])
      expect(result.sessions.map((session) => session.filePath)).toContain(wslFile.path)
      expect(discoveries[0].cursorDiscoveryCounters?.returnedBytes).toBe(
        nativePayloadBytes * nativeFileCount
      )
      expect(discoveries[1].cursorDiscoveryCounters?.returnedBytes).toBe(wslPayloadBytes)
      expect(
        discoveries.map((discovery) => discovery.cursorDiscoveryTruncated?.sidecarBytes)
      ).toEqual([false, false])
    } finally {
      span.end()
    }
  }, 30_000)
})

function sidecarDiscovery(
  storageKey: string,
  rootDir: string,
  expectedRootRealPath: string,
  files: FileWithMtime[]
): SessionFileDiscovery {
  return {
    agent: 'cursor',
    cursorDiscoveryCounters: {
      boundedReads: 0,
      bucketReaddir: 0,
      elapsedMs: 0,
      fileLstat: 0,
      returnedBytes: 0,
      rootReaddir: 0,
      scopeRealpath: 0
    },
    cursorDiscoveryTruncated: {
      buckets: false,
      scopePaths: false,
      sessionDirs: false,
      sidecarBytes: false
    },
    cursorExpectedRootRealPath: expectedRootRealPath,
    cursorLayout: 'sidecar',
    cursorStorageContextKey: storageKey,
    files,
    rootDir
  }
}

function discoveryCandidates(discovery: SessionFileDiscovery): SessionFileCandidate[] {
  return discovery.files.map((file) => ({
    agent: 'cursor',
    codexHome: null,
    cursorExpectedRootRealPath: discovery.cursorExpectedRootRealPath,
    cursorLayout: 'sidecar',
    cursorStorageContextKey: discovery.cursorStorageContextKey,
    file
  }))
}

async function addSession(
  chatsDir: string,
  sessionId: string,
  content: string,
  mtimeMs: number
): Promise<FileWithMtime> {
  const bucket = createHash('md5').update(sessionId).digest('hex')
  const sessionDir = join(chatsDir, bucket, sessionId)
  const metaPath = join(sessionDir, 'meta.json')
  const storePath = join(sessionDir, 'store.db')
  await mkdir(sessionDir, { recursive: true })
  await Promise.all([writeFile(metaPath, content), writeFile(storePath, '')])
  const timestamp = new Date(mtimeMs)
  await Promise.all([
    utimes(metaPath, timestamp, timestamp),
    utimes(storePath, timestamp, timestamp)
  ])
  const [meta, store] = await Promise.all([lstat(metaPath), lstat(storePath)])
  return {
    cursorStoreMtimeMs: store.mtimeMs,
    dev: meta.dev,
    ino: meta.ino,
    modifiedAt: meta.mtime.toISOString(),
    mtimeMs: meta.mtimeMs,
    nlink: meta.nlink,
    path: metaPath,
    sizeBytes: meta.size
  }
}

function sidecarPayload(byteLength: number): string {
  const prefix = '{"createdAtMs":1,"updatedAtMs":2,"hasConversation":true,"title":"session","pad":"'
  const suffix = '"}'
  return `${prefix}${'a'.repeat(byteLength - Buffer.byteLength(prefix + suffix))}${suffix}`
}
