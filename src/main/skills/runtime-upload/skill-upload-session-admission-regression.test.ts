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

// Models Windows delete-pending rmdir: the first removal wins and every later one gets EPERM.
const deletePendingGate = vi.hoisted((): { removed: Set<string> | null } => ({ removed: null }))

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
    },
    rm: async (path: string, options?: Parameters<typeof actual.rm>[1]) => {
      const removed = deletePendingGate.removed
      if (removed?.has(path)) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rmdir '${path}'`), {
          code: 'EPERM'
        })
      }
      removed?.add(path)
      await actual.rm(path, options)
    }
  }
})

afterEach(async () => {
  vi.useRealTimers()
  openGate.release = null
  openGate.started = null
  deletePendingGate.removed = null
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
