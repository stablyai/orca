import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureArtifactShareLifecycle,
  clearArtifactShareRecords,
  getArtifactShareRecord,
  isArtifactShareLifecycleCurrent,
  refreshArtifactShareRecordExpiration,
  removeArtifactShareRecords,
  saveArtifactShareRecord,
  type ArtifactShareScope
} from './artifact-share-record-store'

const createdPaths: string[] = []
const scopeA: ArtifactShareScope = {
  cloudUserId: 'user-a',
  cloudProfileId: 'cloud-a',
  cloudOrganizationId: 'org-a',
  apiOrigin: 'https://share.onorca.dev'
}

async function userDataPath(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'orca-artifact-records-'))
  createdPaths.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('artifact share record store', () => {
  it('isolates edit tokens by cloud identity and API origin', async () => {
    const path = await userDataPath()
    saveArtifactShareRecord('local-profile', path, '/repo/report.html', {
      ...scopeA,
      slug: 'artifact-a',
      editToken: 'secret-a',
      shareUrl: 'https://share.onorca.dev/a/artifact-a'
    })

    expect(
      getArtifactShareRecord('local-profile', path, '/repo/report.html', scopeA)?.editToken
    ).toBe('secret-a')
    expect(
      getArtifactShareRecord('local-profile', path, '/repo/report.html', {
        ...scopeA,
        cloudUserId: 'user-b'
      })
    ).toBeNull()
    expect(
      getArtifactShareRecord('local-profile', path, '/repo/report.html', {
        ...scopeA,
        cloudOrganizationId: 'org-b'
      })
    ).toBeNull()
    expect(
      getArtifactShareRecord('local-profile', path, '/repo/report.html', {
        ...scopeA,
        apiOrigin: 'http://localhost:3000'
      })
    ).toBeNull()
  })

  it('removes every source mapping for a deleted slug in the matching scope', async () => {
    const path = await userDataPath()
    for (const sourceKey of ['/repo/report.html', '/repo/report-copy.html']) {
      saveArtifactShareRecord('local-profile', path, sourceKey, {
        ...scopeA,
        slug: 'artifact-a',
        editToken: 'secret-a',
        shareUrl: 'https://share.onorca.dev/a/artifact-a'
      })
    }

    removeArtifactShareRecords('local-profile', path, scopeA, { slug: 'artifact-a' })

    expect(getArtifactShareRecord('local-profile', path, '/repo/report.html', scopeA)).toBeNull()
    expect(
      getArtifactShareRecord('local-profile', path, '/repo/report-copy.html', scopeA)
    ).toBeNull()
  })

  it('discards unscoped version-one records instead of assigning them to a new login', async () => {
    const path = await userDataPath()
    clearArtifactShareRecords('local-profile', path)
    const recordsPath = join(path, 'profiles', 'local-profile', 'artifact-shares.json')
    await writeFile(
      recordsPath,
      JSON.stringify({
        version: 1,
        shares: {
          '/repo/report.html': {
            slug: 'artifact-a',
            editToken: 'legacy-secret',
            shareUrl: 'https://share.onorca.dev/a/artifact-a'
          }
        }
      })
    )

    expect(getArtifactShareRecord('local-profile', path, '/repo/report.html', scopeA)).toBeNull()
    expect(await readFile(recordsPath, 'utf8')).toContain('legacy-secret')
  })

  it('prunes expired records on read', async () => {
    const path = await userDataPath()
    clearArtifactShareRecords('local-profile', path)
    const recordsPath = join(path, 'profiles', 'local-profile', 'artifact-shares.json')
    await writeFile(
      recordsPath,
      JSON.stringify({
        version: 2,
        lifecycleGeneration: 0,
        shares: {
          '/repo/report.html': {
            ...scopeA,
            slug: 'artifact-a',
            editToken: 'expired-secret',
            shareUrl: 'https://share.onorca.dev/a/artifact-a',
            expiresAt: '2020-01-01T00:00:00.000Z',
            savedAt: 1
          }
        }
      })
    )

    expect(getArtifactShareRecord('local-profile', path, '/repo/report.html', scopeA)).toBeNull()
    const persisted = JSON.parse(await readFile(recordsPath, 'utf8')) as { shares: object }
    expect(persisted.shares).toEqual({})
  })

  it('caps records deterministically at ten thousand', async () => {
    const path = await userDataPath()
    clearArtifactShareRecords('local-profile', path)
    const recordsPath = join(path, 'profiles', 'local-profile', 'artifact-shares.json')
    const shares = Object.fromEntries(
      Array.from({ length: 10_001 }, (_, index) => [
        `/repo/report-${String(index).padStart(5, '0')}.html`,
        {
          ...scopeA,
          slug: `artifact-${index}`,
          editToken: `secret-${index}`,
          shareUrl: `https://share.onorca.dev/a/artifact-${index}`,
          expiresAt: '2099-01-01T00:00:00.000Z',
          savedAt: index
        }
      ])
    )
    await writeFile(recordsPath, JSON.stringify({ version: 2, lifecycleGeneration: 0, shares }))

    expect(
      getArtifactShareRecord('local-profile', path, '/repo/report-10000.html', scopeA)?.editToken
    ).toBe('secret-10000')
    expect(
      getArtifactShareRecord('local-profile', path, '/repo/report-00000.html', scopeA)
    ).toBeNull()
    const persisted = JSON.parse(await readFile(recordsPath, 'utf8')) as {
      shares: Record<string, unknown>
    }
    expect(Object.keys(persisted.shares)).toHaveLength(10_000)
  })

  it('keeps usable legacy version-two records without timestamps', async () => {
    const path = await userDataPath()
    clearArtifactShareRecords('local-profile', path)
    const recordsPath = join(path, 'profiles', 'local-profile', 'artifact-shares.json')
    await writeFile(
      recordsPath,
      JSON.stringify({
        version: 2,
        lifecycleGeneration: 0,
        shares: {
          '/repo/legacy.html': {
            cloudUserId: scopeA.cloudUserId,
            cloudProfileId: scopeA.cloudProfileId,
            apiOrigin: scopeA.apiOrigin,
            slug: 'legacy-artifact',
            editToken: 'legacy-secret',
            shareUrl: 'https://share.onorca.dev/a/legacy-artifact'
          }
        }
      })
    )

    expect(
      getArtifactShareRecord('local-profile', path, '/repo/legacy.html', scopeA)?.editToken
    ).toBe('legacy-secret')
    refreshArtifactShareRecordExpiration(
      'local-profile',
      path,
      '/repo/legacy.html',
      scopeA,
      { slug: 'legacy-artifact', editToken: 'legacy-secret' },
      '2099-01-01T00:00:00.000Z'
    )
    saveArtifactShareRecord('local-profile', path, '/repo/new.html', {
      ...scopeA,
      slug: 'new-artifact',
      editToken: 'new-secret',
      shareUrl: 'https://share.onorca.dev/a/new-artifact',
      expiresAt: '2099-01-01T00:00:00.000Z'
    })

    const persisted = JSON.parse(await readFile(recordsPath, 'utf8')) as {
      shares: Record<string, { cloudOrganizationId?: string; savedAt?: number }>
    }
    expect(persisted.shares['/repo/legacy.html']?.cloudOrganizationId).toBe('org-a')
    expect(persisted.shares['/repo/legacy.html']?.savedAt).toEqual(expect.any(Number))
    expect(persisted.shares['/repo/new.html']?.savedAt).toEqual(expect.any(Number))
    expect(
      getArtifactShareRecord('local-profile', path, '/repo/legacy.html', {
        ...scopeA,
        cloudOrganizationId: 'org-b'
      })
    ).toBeNull()
  })

  it('refuses to overwrite an unreadable existing record file', async () => {
    const path = await userDataPath()
    clearArtifactShareRecords('local-profile', path)
    const recordsPath = join(path, 'profiles', 'local-profile', 'artifact-shares.json')
    await writeFile(recordsPath, '{broken-json')

    expect(() =>
      saveArtifactShareRecord('local-profile', path, '/repo/new.html', {
        ...scopeA,
        slug: 'new-artifact',
        editToken: 'new-secret',
        shareUrl: 'https://share.onorca.dev/a/new-artifact',
        expiresAt: '2099-01-01T00:00:00.000Z'
      })
    ).toThrow(/could not be read safely/)
    expect(await readFile(recordsPath, 'utf8')).toBe('{broken-json')
  })

  it('clears an unreadable file and invalidates in-flight writes', async () => {
    const path = await userDataPath()
    clearArtifactShareRecords('local-profile', path)
    const lifecycle = captureArtifactShareLifecycle('local-profile', path)
    const recordsPath = join(path, 'profiles', 'local-profile', 'artifact-shares.json')
    await writeFile(recordsPath, '{broken-json')

    expect(() => clearArtifactShareRecords('local-profile', path)).not.toThrow()
    expect(isArtifactShareLifecycleCurrent('local-profile', path, lifecycle)).toBe(false)
    const persisted = JSON.parse(await readFile(recordsPath, 'utf8')) as {
      lifecycleNonce?: string
      shares: object
    }
    expect(persisted.lifecycleNonce).toMatch(/^[0-9a-f-]{36}$/)
    expect(persisted.shares).toEqual({})
  })
})
