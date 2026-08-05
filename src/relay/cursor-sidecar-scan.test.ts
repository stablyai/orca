import { chmod, mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { scanCursorSidecars } from './cursor-sidecar-scan'
import { defaultCursorSidecarScanRequest } from '../shared/cursor-sidecar-scan'
import { cursorBucketForCwd } from '../main/ai-vault/session-scanner-cursor-paths'

const roots: string[] = []
const context = { clientId: 1, isStale: () => false }

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
      fileLstat: 2,
      boundedReads: 1,
      scopeRealpath: 1
    })
    expect(result.truncated).toEqual({
      scopePaths: false,
      buckets: false,
      sessionDirs: false,
      sidecarBytes: false
    })
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
