import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SkillUploadSessionService } from './skill-upload-session-service'

const roots: string[] = []

const openGate = vi.hoisted(() => ({
  release: null as Promise<void> | null,
  started: null as (() => void) | null
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    open: async (path: string, flags: string, mode?: number) => {
      const handle = await actual.open(path, flags, mode)
      if (openGate.release) {
        const release = openGate.release
        openGate.release = null
        openGate.started?.()
        await release
      }
      return handle
    }
  }
})

type RetainedPathCleanup = {
  removeFailedCleanup(path: string): Promise<void>
}

afterEach(async () => {
  vi.useRealTimers()
  openGate.release = null
  openGate.started = null
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function identity(bytes: Buffer) {
  return {
    packageId: 'package_1',
    versionId: 'version_1',
    packageDigest: 'a'.repeat(64),
    archiveSha256: createHash('sha256').update(bytes).digest('hex'),
    compressedBytes: bytes.length
  }
}

function retainedPathCleanup(service: SkillUploadSessionService): RetainedPathCleanup {
  return Reflect.get(service, 'retainedPaths') as RetainedPathCleanup
}

async function stagedArchiveCount(uploads: string): Promise<number> {
  const owners = await readdir(uploads, { withFileTypes: true })
  const archives = await Promise.all(
    owners
      .filter((entry) => entry.isDirectory())
      .map(async (entry) =>
        (await readdir(join(uploads, entry.name))).filter((name) => name.endsWith('.tar.gz'))
      )
  )
  return archives.flat().length
}

describe('SkillUploadSessionService admission regressions', () => {
  it('does not return a session after disposal starts during pruning', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-23T00:00:00Z'))
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-upload-admission-'))
    roots.push(root)
    const uploads = join(root, 'uploads')
    const service = new SkillUploadSessionService(uploads, { idleMs: 10 })
    await service.begin({ package: identity(Buffer.from('expired')) })
    vi.setSystemTime(new Date('2026-08-23T00:00:00.005Z'))
    const activeRequest = {
      package: identity(Buffer.from('active')),
      transferId: 'active-transfer'
    }
    await service.begin(activeRequest)
    vi.setSystemTime(new Date('2026-08-23T00:00:00.011Z'))

    const retainedPaths = retainedPathCleanup(service)
    const removeFailedCleanup = retainedPaths.removeFailedCleanup.bind(retainedPaths)
    let releaseCleanup!: () => void
    const cleanupReleased = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    let markCleanupStarted!: () => void
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve
    })
    vi.spyOn(retainedPaths, 'removeFailedCleanup').mockImplementation(async (path) => {
      markCleanupStarted()
      await cleanupReleased
      await removeFailedCleanup(path)
    })

    const begin = service.begin(activeRequest)
    await cleanupStarted
    const disposal = service.dispose()
    releaseCleanup()
    const [beginResult] = await Promise.allSettled([begin])
    await disposal

    expect(beginResult).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'skill-upload-service-disposed' })
    })
    expect(await stagedArchiveCount(uploads)).toBe(0)
  })

  it('retries transient failed cleanup before rejecting recovered capacity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-upload-admission-'))
    roots.push(root)
    const uploads = join(root, 'uploads')
    const service = new SkillUploadSessionService(uploads)
    const retainedPaths = retainedPathCleanup(service)
    const removeFailedCleanup = retainedPaths.removeFailedCleanup.bind(retainedPaths)
    let failuresRemaining = 4
    vi.spyOn(retainedPaths, 'removeFailedCleanup').mockImplementation(async (path) => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1
        throw new Error('injected-transient-rm-failure')
      }
      await removeFailedCleanup(path)
    })

    const sessions = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        service.begin({ package: identity(Buffer.from(`failed-cleanup-${index}`)) })
      )
    )
    for (const session of sessions) {
      await expect(service.cancel(session.uploadId)).rejects.toThrow(
        'injected-transient-rm-failure'
      )
    }
    expect(await stagedArchiveCount(uploads)).toBe(4)

    await expect(
      service.begin({ package: identity(Buffer.from('recovered-capacity')) })
    ).resolves.toMatchObject({ acknowledgedOffset: 0 })
    expect(await stagedArchiveCount(uploads)).toBe(1)
    await service.dispose()
  })

  it('removes an unpublished archive when disposal starts during open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-upload-admission-'))
    roots.push(root)
    const uploads = join(root, 'uploads')
    const service = new SkillUploadSessionService(uploads)
    let releaseOpen!: () => void
    openGate.release = new Promise<void>((resolve) => {
      releaseOpen = resolve
    })
    let markOpenStarted!: () => void
    const openStarted = new Promise<void>((resolve) => {
      markOpenStarted = resolve
    })
    openGate.started = markOpenStarted

    const begin = service.begin({ package: identity(Buffer.from('opened-during-disposal')) })
    await openStarted
    const disposal = service.dispose()
    releaseOpen()
    const [beginResult] = await Promise.allSettled([begin])
    await disposal

    expect(beginResult).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'skill-upload-service-disposed' })
    })
    expect(await stagedArchiveCount(uploads)).toBe(0)
  })
})
