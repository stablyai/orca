import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appGetPathMock } = vi.hoisted(() => ({ appGetPathMock: vi.fn() }))

vi.mock('electron', () => ({ app: { getPath: appGetPathMock } }))

import { ORPHAN_GRACE_MS, sweepOrphanedPets } from './pet-orphan-sweep'

const KNOWN = '11111111-2222-3333-4444-555555555555'
const GONE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

let userDataDir = ''
let petsDir = ''

/** Backdates an entry past the grace period. */
async function age(path: string): Promise<void> {
  const when = new Date(Date.now() - ORPHAN_GRACE_MS - 60_000)
  await utimes(path, when, when)
}

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'orca-pet-sweep-'))
  petsDir = join(userDataDir, 'sidekicks', 'custom')
  await mkdir(petsDir, { recursive: true })
  appGetPathMock.mockReturnValue(userDataDir)
})

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true })
})

describe('sweepOrphanedPets', () => {
  it('removes the bytes of a pet the app no longer lists', async () => {
    const dir = join(petsDir, GONE)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'spritesheet.webp'), 'x')
    await age(dir)

    await sweepOrphanedPets([KNOWN])

    expect(await readdir(petsDir)).toEqual([])
  })

  it('never touches a pet that is still listed', async () => {
    const dir = join(petsDir, KNOWN)
    await mkdir(dir, { recursive: true })
    await age(dir)

    await sweepOrphanedPets([KNOWN])

    expect(await readdir(petsDir)).toEqual([KNOWN])
  })

  it('leaves a pet written moments ago alone', async () => {
    await mkdir(join(petsDir, GONE), { recursive: true })

    await sweepOrphanedPets([])

    expect(await readdir(petsDir)).toEqual([GONE])
  })

  it('does nothing at all when there is no pets directory yet', async () => {
    await rm(petsDir, { recursive: true, force: true })

    await expect(sweepOrphanedPets([KNOWN])).resolves.toBeUndefined()
  })
})
