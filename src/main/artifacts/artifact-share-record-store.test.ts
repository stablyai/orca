import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureArtifactShareLifecycle,
  clearArtifactShareRecords,
  isArtifactShareLifecycleCurrent,
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
  it('refuses to overwrite an unreadable existing record file', async () => {
    const path = await userDataPath()
    clearArtifactShareRecords('local-profile', path)
    const recordsPath = join(path, 'profiles', 'local-profile', 'artifact-shares.json')
    await writeFile(recordsPath, '{broken-json')

    await expect(
      saveArtifactShareRecord(
        'local-profile',
        path,
        '/repo/new.html',
        {
          ...scopeA,
          slug: 'new-artifact',
          editToken: 'new-secret',
          shareUrl: 'https://share.onorca.dev/a/new-artifact',
          expiresAt: '2099-01-01T00:00:00.000Z'
        },
        () => {}
      )
    ).rejects.toThrow(/could not be read safely/)
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
