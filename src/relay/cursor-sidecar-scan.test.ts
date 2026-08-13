import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { scanCursorSidecars } from './cursor-sidecar-scan'
import {
  CURSOR_SIDECAR_MAX_BYTES,
  defaultCursorSidecarScanRequest
} from '../shared/cursor-sidecar-scan'
import { cursorBucketForCwd } from '../main/ai-vault/session-scanner-cursor-paths'

const roots: string[] = []
const context = { clientId: 1, isStale: () => false }
const CHECKS_BEFORE_FIRST_VERIFIED_READ = 9

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-cursor-scan-'))
  roots.push(root)
  return root
}

async function addSession(
  chatsRoot: string,
  bucket: string,
  sessionId: string,
  content = JSON.stringify({ createdAtMs: 10, hasConversation: true })
): Promise<void> {
  const sessionDir = join(chatsRoot, bucket, sessionId)
  await mkdir(sessionDir, { recursive: true })
  await Promise.all([
    writeFile(join(sessionDir, 'meta.json'), content),
    writeFile(join(sessionDir, 'store.db'), '')
  ])
}

async function setSessionMtime(
  chatsRoot: string,
  bucket: string,
  sessionId: string,
  mtimeMs: number
): Promise<void> {
  const timestamp = new Date(mtimeMs)
  await Promise.all(
    ['meta.json', 'store.db'].map((name) =>
      utimes(join(chatsRoot, bucket, sessionId, name), timestamp, timestamp)
    )
  )
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('scanCursorSidecars', () => {
  it('discovers an exact scope bucket in one bounded owning-host operation', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    const cwd = join(root, 'workspace')
    await mkdir(cwd)
    const bucket = cursorBucketForCwd(cwd, process.platform)
    await addSession(chatsRoot, bucket, 'opaque-id')

    const result = await scanCursorSidecars(
      defaultCursorSidecarScanRequest(chatsRoot, [cwd, cwd], process.platform),
      context
    )

    expect(result.sidecars).toHaveLength(1)
    expect(result.sidecars[0]).toMatchObject({
      bucket,
      sessionId: 'opaque-id',
      scopeCwd: cwd
    })
    expect(result.counters).toMatchObject({
      rootReaddir: 1,
      bucketReaddir: 1,
      boundedReads: 1,
      scopeRealpath: 1
    })
    // Scope-bucket existence lstat(s) plus meta/store lstats; macOS realpath may
    // add a second scope variant whose missing bucket is still counted.
    expect(result.counters.fileLstat).toBeGreaterThanOrEqual(3)
    expect(result.truncated).toEqual({
      scopePaths: false,
      buckets: false,
      sessionDirs: false,
      sidecarBytes: false
    })
  })

  it('shares bounded session capacity across exact scope buckets', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    const scopes = [join(root, 'a-workspace'), join(root, 'z-workspace')]
    await Promise.all(scopes.map((scope) => mkdir(scope)))
    const firstBucket = cursorBucketForCwd(scopes[0], process.platform)
    await Promise.all([
      addSession(chatsRoot, firstBucket, 'first-a'),
      addSession(chatsRoot, firstBucket, 'first-b'),
      addSession(chatsRoot, cursorBucketForCwd(scopes[1], process.platform), 'second')
    ])
    const request = defaultCursorSidecarScanRequest(chatsRoot, scopes, process.platform)
    request.maxSessionDirs = 2

    const result = await scanCursorSidecars(request, context)

    expect(result.sidecars.map((sidecar) => sidecar.sessionId).sort()).toEqual([
      'first-a',
      'second'
    ])
    expect(result.truncated.sessionDirs).toBe(true)
  })

  it('keeps exact scope sessions within the requested cap', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    const scope = join(root, 'workspace')
    await mkdir(scope)
    const bucket = cursorBucketForCwd(scope, process.platform)
    await Promise.all([
      addSession(chatsRoot, bucket, 'first-scoped'),
      addSession(chatsRoot, bucket, 'second-scoped')
    ])
    const request = defaultCursorSidecarScanRequest(chatsRoot, [scope], process.platform)
    request.maxSessionDirs = 1

    const result = await scanCursorSidecars(request, context)

    expect(result.sidecars).toHaveLength(1)
    expect(result.truncated.sessionDirs).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'keeps missing files silent and rejects symlinked sidecars',
    async () => {
      const root = await createRoot()
      const chatsRoot = join(root, 'chats')
      const bucket = '11111111111111111111111111111111'
      await addSession(chatsRoot, bucket, 'valid')
      const missingStore = join(chatsRoot, bucket, 'missing-store')
      await mkdir(missingStore)
      await writeFile(join(missingStore, 'meta.json'), '{}')
      const linked = join(chatsRoot, bucket, 'linked')
      await mkdir(linked)
      await Promise.all([
        symlink(join(chatsRoot, bucket, 'valid', 'meta.json'), join(linked, 'meta.json')),
        writeFile(join(linked, 'store.db'), '')
      ])

      const result = await scanCursorSidecars(
        defaultCursorSidecarScanRequest(chatsRoot, [], process.platform),
        context
      )
      expect(result.sidecars.map((sidecar) => sidecar.sessionId)).toEqual(['valid'])
      expect(result.issues).toEqual([])
    }
  )

  it('clamps session and aggregate-content bounds and reports one issue per dimension', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    const bucket = '22222222222222222222222222222222'
    await addSession(chatsRoot, bucket, 'a')
    await addSession(chatsRoot, bucket, 'b')
    const request = defaultCursorSidecarScanRequest(chatsRoot, [], process.platform)
    request.maxSessionDirs = 1
    request.maxAggregateBytes = 1

    const result = await scanCursorSidecars(request, context)
    expect(result.sidecars).toEqual([])
    expect(result.truncated).toMatchObject({ sessionDirs: true, sidecarBytes: true })
    expect(result.issues.filter((issue) => issue.message.includes('truncated'))).toHaveLength(2)
  })

  it('does not report session truncation when the retained count exactly fits', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    await addSession(chatsRoot, '33333333333333333333333333333333', 'only')
    const request = defaultCursorSidecarScanRequest(chatsRoot, [], process.platform)
    request.maxSessionDirs = 1

    const result = await scanCursorSidecars(request, context)
    expect(result.sidecars).toHaveLength(1)
    expect(result.truncated.sessionDirs).toBe(false)
  })

  it('does not report session truncation when the retained count exactly matches the cap', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    await addSession(chatsRoot, '33333333333333333333333333333333', 'only-session')
    const request = defaultCursorSidecarScanRequest(chatsRoot, [], process.platform)
    request.maxSessionDirs = 1

    const result = await scanCursorSidecars(request, context)

    expect(result.sidecars).toHaveLength(1)
    expect(result.truncated.sessionDirs).toBe(false)
  })

  it('does not report session truncation for an already-examined empty bucket', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    await addSession(chatsRoot, '33333333333333333333333333333333', 'only-session')
    await mkdir(join(chatsRoot, '44444444444444444444444444444444'))
    const request = defaultCursorSidecarScanRequest(chatsRoot, [], process.platform)
    request.maxSessionDirs = 1

    const result = await scanCursorSidecars(request, context)

    expect(result.sidecars).toHaveLength(1)
    expect(result.truncated.sessionDirs).toBe(false)
  })

  it('prioritizes exact-scope candidates before newer unrelated sidecars at the byte cap', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    const cwd = join(root, 'workspace')
    await mkdir(cwd)
    const scopeBucket = cursorBucketForCwd(cwd, process.platform)
    const otherBucket = '44444444444444444444444444444444'
    const scopedContent = JSON.stringify({ createdAtMs: 10, title: 'scoped' })
    await addSession(chatsRoot, scopeBucket, 'scoped', scopedContent)
    await addSession(chatsRoot, otherBucket, 'newer', scopedContent)
    await setSessionMtime(chatsRoot, scopeBucket, 'scoped', 1_000)
    await setSessionMtime(chatsRoot, otherBucket, 'newer', 10_000)
    const request = defaultCursorSidecarScanRequest(chatsRoot, [cwd], process.platform)
    request.maxAggregateBytes = Buffer.byteLength(scopedContent)

    const result = await scanCursorSidecars(request, context)

    expect(result.sidecars.map((sidecar) => sidecar.sessionId)).toEqual(['scoped'])
    expect(result.truncated.sidecarBytes).toBe(true)
  })

  it('orders equal-mtime candidates by lexical physical key before truncating', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    const content = JSON.stringify({ createdAtMs: 10 })
    const firstBucket = '55555555555555555555555555555555'
    const secondBucket = '66666666666666666666666666666666'
    await addSession(chatsRoot, secondBucket, 'session', content)
    await addSession(chatsRoot, firstBucket, 'session', content)
    await setSessionMtime(chatsRoot, firstBucket, 'session', 1_000)
    await setSessionMtime(chatsRoot, secondBucket, 'session', 1_000)
    const request = defaultCursorSidecarScanRequest(chatsRoot, [], process.platform)
    request.maxAggregateBytes = Buffer.byteLength(content)

    const result = await scanCursorSidecars(request, context)

    expect(result.sidecars.map((sidecar) => sidecar.bucket)).toEqual([firstBucket])
  })

  it('lets direct scope buckets bypass only the enumerated bucket quota', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    const cwd = join(root, 'workspace')
    await mkdir(cwd)
    const scopeBucket = cursorBucketForCwd(cwd, process.platform)
    await addSession(chatsRoot, scopeBucket, 'scoped')
    await addSession(chatsRoot, '77777777777777777777777777777777', 'first-enumerated')
    await addSession(chatsRoot, '88888888888888888888888888888888', 'truncated-enumerated')
    const request = defaultCursorSidecarScanRequest(chatsRoot, [cwd], process.platform)
    request.maxBuckets = 1

    const result = await scanCursorSidecars(request, context)

    expect(result.sidecars.map((sidecar) => sidecar.sessionId).sort()).toEqual([
      'first-enumerated',
      'scoped'
    ])
    expect(result.truncated.buckets).toBe(true)
    expect(result.counters.bucketReaddir).toBe(2)
  })

  it('skips sidecars already over the per-file cap without opening them', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    await addSession(chatsRoot, '99999999999999999999999999999999', 'oversized', 'x'.repeat(32))
    const request = defaultCursorSidecarScanRequest(chatsRoot, [], process.platform)
    request.maxSidecarBytes = 16

    const result = await scanCursorSidecars(request, context)

    expect(result.sidecars).toEqual([])
    expect(result.counters.boundedReads).toBe(0)
    expect(result.issues).toContainEqual(
      expect.objectContaining({ message: 'Cursor session metadata exceeds the read limit.' })
    )
  })

  it('isolates invalid UTF-8 metadata without rejecting other sidecars', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    const bucket = 'abababababababababababababababab'
    const validContent = JSON.stringify({ createdAtMs: 10, title: 'valid' })
    await Promise.all([
      addSession(chatsRoot, bucket, 'aaa-invalid'),
      addSession(chatsRoot, bucket, 'zzz-valid', validContent)
    ])
    const invalidPath = join(chatsRoot, bucket, 'aaa-invalid', 'meta.json')
    await writeFile(invalidPath, Buffer.alloc(100_000, 0x80))

    const result = await scanCursorSidecars(
      defaultCursorSidecarScanRequest(chatsRoot, [], process.platform),
      context
    )

    expect(result.sidecars.map((sidecar) => sidecar.sessionId)).toEqual(['zzz-valid'])
    expect(result.counters.returnedBytes).toBe(Buffer.byteLength(validContent))
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: invalidPath, message: 'invalid_utf8' })
    )
  })

  it('isolates response-invalid file timestamps without rejecting other sidecars', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    const bucket = 'acacacacacacacacacacacacacacacac'
    await Promise.all([
      addSession(chatsRoot, bucket, 'invalid-time'),
      addSession(chatsRoot, bucket, 'valid')
    ])
    await setSessionMtime(chatsRoot, bucket, 'invalid-time', -1_000)

    const result = await scanCursorSidecars(
      defaultCursorSidecarScanRequest(chatsRoot, [], process.platform),
      context
    )

    expect(result.sidecars.map((sidecar) => sidecar.sessionId)).toEqual(['valid'])
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: join(chatsRoot, bucket, 'invalid-time', 'meta.json'),
        message: 'Cursor session metadata has invalid file timestamps.'
      })
    )
  })

  it('normalizes scope truncation deterministically inside the owning-host scan', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    const first = join(root, 'a-workspace')
    const second = join(root, 'z-workspace')
    await Promise.all([mkdir(first), mkdir(second), mkdir(chatsRoot)])
    const request = defaultCursorSidecarScanRequest(chatsRoot, [second, first], process.platform)
    request.maxScopePaths = 1

    const result = await scanCursorSidecars(request, context)

    expect(result.scopeCwds).toContain(first)
    expect(result.scopeCwds).not.toContain(second)
    expect(result.truncated.scopePaths).toBe(true)
  })

  it('stops when the relay request is already cancelled', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    await mkdir(chatsRoot)

    await expect(
      scanCursorSidecars(defaultCursorSidecarScanRequest(chatsRoot, [], process.platform), {
        clientId: 1,
        isStale: () => true
      })
    ).rejects.toThrow('cursor_sidecar_scan_cancelled')
  })

  it('rejects when cancellation flips after the first enumeration check', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    await addSession(chatsRoot, 'cccccccccccccccccccccccccccccccc', 'alive')
    let checks = 0
    await expect(
      scanCursorSidecars(defaultCursorSidecarScanRequest(chatsRoot, [], process.platform), {
        clientId: 1,
        isStale: () => {
          checks += 1
          return checks > 1
        }
      })
    ).rejects.toThrow('cursor_sidecar_scan_cancelled')
  })

  it('rejects when cancellation lands during the final verified sidecar read', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    await addSession(chatsRoot, 'cccccccccccccccccccccccccccccccc', 'alive')
    let checks = 0

    await expect(
      scanCursorSidecars(defaultCursorSidecarScanRequest(chatsRoot, [], process.platform), {
        clientId: 1,
        isStale: () => {
          checks += 1
          return checks > CHECKS_BEFORE_FIRST_VERIFIED_READ
        }
      })
    ).rejects.toThrow('cursor_sidecar_scan_cancelled')
  })

  it('stops after a raced sidecar grows past the verified-read limit', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    const bucket = 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd'
    await Promise.all([
      addSession(chatsRoot, bucket, 'first'),
      addSession(chatsRoot, bucket, 'second')
    ])
    let checks = 0

    const result = await scanCursorSidecars(
      defaultCursorSidecarScanRequest(chatsRoot, [], process.platform),
      {
        clientId: 1,
        isStale: () => {
          checks += 1
          if (checks === CHECKS_BEFORE_FIRST_VERIFIED_READ) {
            for (const sessionId of ['first', 'second']) {
              writeFileSync(
                join(chatsRoot, bucket, sessionId, 'meta.json'),
                'x'.repeat(CURSOR_SIDECAR_MAX_BYTES + 1)
              )
            }
          }
          return false
        }
      }
    )

    expect(result.sidecars).toEqual([])
    expect(result.counters.boundedReads).toBe(1)
    expect(result.counters.returnedBytes).toBe(0)
    expect(result.truncated.sidecarBytes).toBe(true)
    expect(result.issues).toContainEqual(expect.objectContaining({ message: 'file_too_large' }))
  })

  it('bounds a raced sidecar by the remaining aggregate budget', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    const bucket = 'dededededededededededededededede'
    const racePath = join(chatsRoot, bucket, 'race', 'meta.json')
    await Promise.all([
      addSession(chatsRoot, bucket, 'filler', 'f'.repeat(90)),
      addSession(chatsRoot, bucket, 'race', 'r'.repeat(5))
    ])
    await setSessionMtime(chatsRoot, bucket, 'filler', 10_000)
    await setSessionMtime(chatsRoot, bucket, 'race', 1_000)
    const request = defaultCursorSidecarScanRequest(chatsRoot, [], process.platform)
    request.maxAggregateBytes = 100
    let checks = 0

    const result = await scanCursorSidecars(request, {
      clientId: 1,
      isStale: () => {
        checks += 1
        if (checks === CHECKS_BEFORE_FIRST_VERIFIED_READ) {
          writeFileSync(racePath, 'x'.repeat(20))
        }
        return false
      }
    })

    expect(result.sidecars.map((sidecar) => sidecar.sessionId)).toEqual(['filler'])
    expect(result.counters.returnedBytes).toBe(90)
    expect(result.truncated.sidecarBytes).toBe(true)
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: racePath, message: 'file_too_large' })
    )
  })

  it('prioritizes cancellation that lands during a failed raced read', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    const bucket = 'cececececececececececececececece'
    const metaPath = join(chatsRoot, bucket, 'race', 'meta.json')
    await addSession(chatsRoot, bucket, 'race')
    let cancelled = false
    let checks = 0

    await expect(
      scanCursorSidecars(defaultCursorSidecarScanRequest(chatsRoot, [], process.platform), {
        clientId: 1,
        isStale: () => {
          checks += 1
          if (checks === CHECKS_BEFORE_FIRST_VERIFIED_READ) {
            writeFileSync(metaPath, 'x'.repeat(CURSOR_SIDECAR_MAX_BYTES + 1))
            queueMicrotask(() => {
              cancelled = true
            })
          }
          return cancelled
        }
      })
    ).rejects.toThrow('cursor_sidecar_scan_cancelled')
  })

  it('caps generic failed read attempts without charging returned bytes', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    const bucket = 'cfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcf'
    const sessionIds = ['first', 'second']
    await Promise.all(sessionIds.map((sessionId) => addSession(chatsRoot, bucket, sessionId)))
    const request = defaultCursorSidecarScanRequest(chatsRoot, [], process.platform)
    request.maxAggregateBytes = CURSOR_SIDECAR_MAX_BYTES
    let checks = 0

    const result = await scanCursorSidecars(request, {
      clientId: 1,
      isStale: () => {
        checks += 1
        if (checks === CHECKS_BEFORE_FIRST_VERIFIED_READ) {
          for (const sessionId of sessionIds) {
            const metaPath = join(chatsRoot, bucket, sessionId, 'meta.json')
            rmSync(metaPath)
            mkdirSync(metaPath)
          }
        }
        return false
      }
    })

    expect(result.sidecars).toEqual([])
    expect(result.counters.boundedReads).toBe(1)
    expect(result.counters.returnedBytes).toBe(0)
    expect(result.truncated.sidecarBytes).toBe(true)
    expect(result.issues).toContainEqual(
      expect.objectContaining({ message: 'verified_file_not_regular' })
    )
  })

  it('retains the newer equal-size session under a tight aggregate byte cap', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    const content = 'y'.repeat(70)
    const bucket = 'dddddddddddddddddddddddddddddddd'
    await addSession(chatsRoot, bucket, 'aaa-older', content)
    await addSession(chatsRoot, bucket, 'zzz-newer', content)
    await setSessionMtime(chatsRoot, bucket, 'aaa-older', 1_000)
    await setSessionMtime(chatsRoot, bucket, 'zzz-newer', 9_000)
    const request = defaultCursorSidecarScanRequest(chatsRoot, [], process.platform)
    request.maxAggregateBytes = 70

    const result = await scanCursorSidecars(request, context)
    expect(result.sidecars.map((sidecar) => sidecar.sessionId)).toEqual(['zzz-newer'])
    expect(result.counters.returnedBytes).toBe(70)
    expect(result.truncated.sidecarBytes).toBe(true)
  })

  it('does not return all 70 large sidecars past the 16 MiB aggregate', async () => {
    const root = await createRoot()
    const chatsRoot = join(root, 'chats')
    const bucket = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    const payload = `${'{"createdAtMs":1,"updatedAtMs":2,"hasConversation":true,"pad":"'}${'b'.repeat(249_990)}"}`
    const payloadBytes = Buffer.byteLength(payload, 'utf8')
    expect(payloadBytes * 70).toBeGreaterThan(16_777_216)
    for (let index = 0; index < 70; index += 1) {
      await addSession(chatsRoot, bucket, `s-${String(index).padStart(3, '0')}`, payload)
    }
    const result = await scanCursorSidecars(
      defaultCursorSidecarScanRequest(chatsRoot, [], process.platform),
      context
    )
    expect(result.sidecars.length).toBeLessThan(70)
    expect(result.counters.returnedBytes).toBeLessThanOrEqual(16_777_216)
    expect(result.truncated.sidecarBytes).toBe(true)
    const contentTotal = result.sidecars.reduce(
      (total, sidecar) => total + Buffer.byteLength(sidecar.content, 'utf8'),
      0
    )
    expect(contentTotal).toBe(result.counters.returnedBytes)
  })

  it.skipIf(process.platform === 'win32')(
    'continues after an unreadable bucket and reports its path',
    async () => {
      const root = await createRoot()
      const chatsRoot = join(root, 'chats')
      const blockedBucket = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const validBucket = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      await addSession(chatsRoot, blockedBucket, 'blocked')
      await addSession(chatsRoot, validBucket, 'valid')
      const blockedPath = join(chatsRoot, blockedBucket)
      await chmod(blockedPath, 0)
      try {
        const result = await scanCursorSidecars(
          defaultCursorSidecarScanRequest(chatsRoot, [], process.platform),
          context
        )
        expect(result.sidecars.map((sidecar) => sidecar.sessionId)).toEqual(['valid'])
        expect(result.issues).toContainEqual(expect.objectContaining({ path: blockedPath }))
      } finally {
        await chmod(blockedPath, 0o700)
      }
    }
  )

  it('rejects malformed versioned requests before touching the filesystem', async () => {
    await expect(
      scanCursorSidecars(
        {
          ...defaultCursorSidecarScanRequest('/missing', [], process.platform),
          version: 2
        },
        context
      )
    ).rejects.toThrow()
  })

  it('treats a missing chats root as an empty source', async () => {
    const root = await createRoot()
    const result = await scanCursorSidecars(
      defaultCursorSidecarScanRequest(join(root, 'missing'), [], process.platform),
      context
    )
    expect(result.sidecars).toEqual([])
    expect(result.issues).toEqual([])
    expect(result.counters.rootReaddir).toBe(0)
  })
})
