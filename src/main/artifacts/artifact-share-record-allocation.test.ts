import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getArtifactShareRecord } from './artifact-share-record-store'

const createdPaths: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

it('constructs one record map when all ten thousand stored shares remain valid', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'orca-artifact-record-allocation-'))
  createdPaths.push(userDataPath)
  const profileId = 'allocation-profile'
  const profileDirectory = join(userDataPath, 'profiles', profileId)
  await mkdir(profileDirectory, { recursive: true })
  const recordsPath = join(profileDirectory, 'artifact-shares.json')
  const scope = {
    cloudUserId: 'user-a',
    cloudProfileId: 'cloud-a',
    cloudOrganizationId: 'org-a',
    apiOrigin: 'https://share.onorca.dev'
  }
  const sourceKey = 'allocation-source-0'
  const shares = Object.fromEntries(
    Array.from({ length: 10_000 }, (_, index) => [
      `allocation-source-${index}`,
      {
        ...scope,
        slug: `artifact-${index}`,
        editToken: 'synthetic-edit-token',
        shareUrl: `https://share.onorca.dev/a/artifact-${index}`,
        expiresAt: '2099-01-01T00:00:00.000Z',
        savedAt: index
      }
    ])
  )
  const serialized = JSON.stringify({ version: 2, lifecycleGeneration: 7, shares })
  await writeFile(recordsPath, serialized)
  const fromEntries = Object.fromEntries
  let recordMaps = 0
  vi.spyOn(Object, 'fromEntries').mockImplementation((entries) => {
    const result = fromEntries(entries)
    if (Object.hasOwn(result, sourceKey)) {
      recordMaps += 1
    }
    return result
  })

  expect(getArtifactShareRecord(profileId, userDataPath, sourceKey, scope)).toMatchObject({
    slug: 'artifact-0',
    editToken: 'synthetic-edit-token'
  })

  expect(recordMaps).toBe(1)
  expect(await readFile(recordsPath, 'utf8')).toBe(serialized)
})
