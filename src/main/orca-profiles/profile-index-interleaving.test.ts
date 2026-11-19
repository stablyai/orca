import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import {
  createLocalOrcaProfile,
  ensureActiveOrcaProfile,
  readProfileIndex,
  setActiveOrcaProfile
} from './profile-index-store'
import {
  createCloudLinkedOrcaProfileRecord,
  linkOrcaProfileToCloud,
  linkOrcaProfileToCloudAsync
} from './cloud-auth/profile-cloud-index'

const interleave = vi.hoisted((): { run: (() => void) | null; cleanup: (() => void) | null } => ({
  run: null,
  cleanup: null
}))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>()
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]).endsWith('artifact-cloud-cleanup.json') && interleave.cleanup) {
        const marker = JSON.parse(readFileSync(String(args[0]), 'utf8'))
        if (marker.phase === 'committed') {
          interleave.cleanup()
          interleave.cleanup = null
        }
      }
      const contents = await actual.readFile(...args)
      if (String(args[0]).endsWith('orca-profile-index.json')) {
        const run = interleave.run
        interleave.run = null
        run?.()
      }
      return contents
    }
  }
})
import { prepareArtifactCloudUse } from './cloud-auth/profile-artifact-cloud-cleanup'
let home = ''
afterEach(() => {
  interleave.run = null
  interleave.cleanup = null
  rmSync(home, { recursive: true, force: true })
})

it('preserves synchronous creation, switching and cloud links across a background relink', async () => {
  home = mkdtempSync(join(tmpdir(), 'orca-index-interleaving-'))
  const first = ensureActiveOrcaProfile(home)
  const cloud = { userId: 'user', cloudProfileId: 'cloud', email: 'user@example.com', linkedAt: 1 }
  interleave.run = () => {
    const local = createLocalOrcaProfile({ name: 'New local' }, home)
    setActiveOrcaProfile(local.profile.id, home)
    const created = createCloudLinkedOrcaProfileRecord(
      { ...cloud, userId: 'created-user' },
      { name: 'New cloud' },
      home
    )
    linkOrcaProfileToCloud(created.profile.id, { ...cloud, userId: 'linked-user' }, home)
  }
  await linkOrcaProfileToCloudAsync(first.profile.id, cloud, home)
  const run = interleave.run
  interleave.run = null
  run?.()
  const index = readProfileIndex(join(home, 'orca-profile-index.json'))!
  expect(index.profiles).toMatchObject([
    { cloud: { userId: 'user' } },
    { name: 'New local' },
    { name: 'New cloud', cloud: { userId: 'linked-user' } }
  ])
  expect(index.profiles.find((profile) => profile.id === index.activeProfileId)?.name).toBe(
    'New local'
  )
  expect(
    JSON.parse(readFileSync(join(home, 'orca-profile-index.json'), 'utf8')).profiles
  ).toHaveLength(3)
})

it('finishes a committed org change when artifact preparation consumes its cleanup marker', async () => {
  home = mkdtempSync(join(tmpdir(), 'orca-cleanup-interleaving-'))
  const first = ensureActiveOrcaProfile(home)
  const cloud = {
    userId: 'user',
    cloudProfileId: 'cloud',
    email: 'user@example.com',
    linkedAt: 1,
    activeOrgId: 'org-a'
  }
  linkOrcaProfileToCloud(first.profile.id, cloud, home)
  const nextCloud = { ...cloud, activeOrgId: 'org-b' }
  interleave.cleanup = () =>
    prepareArtifactCloudUse({ id: first.profile.id, cloud: nextCloud }, home)
  await expect(
    linkOrcaProfileToCloudAsync(first.profile.id, nextCloud, home)
  ).resolves.toMatchObject({ profiles: [{ cloud: { activeOrgId: 'org-b' } }] })
  prepareArtifactCloudUse({ id: first.profile.id, cloud: nextCloud }, home)
  expect(
    readProfileIndex(join(home, 'orca-profile-index.json'))?.profiles[0].cloud?.activeOrgId
  ).toBe('org-b')
})
