import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_PENDING_ARTIFACT_CREATES,
  clearArtifactCreateIntents,
  getArtifactCreateIntent,
  getOrCreateArtifactCreateIntent,
  removeArtifactCreateIntent
} from './artifact-create-intent-store'
import type { ArtifactShareScope } from './artifact-share-record-store'

const createdPaths: string[] = []
const scope: ArtifactShareScope = {
  cloudUserId: 'user-a',
  cloudProfileId: 'cloud-a',
  cloudOrganizationId: 'org-a',
  apiOrigin: 'https://share.onorca.dev'
}
const body = {
  content: '<h1>Original</h1>',
  contentType: 'text/html',
  fileName: 'report.html',
  title: 'Original'
}

afterEach(async () => {
  await Promise.all(
    createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('artifact create intent store', () => {
  it('retains the first key and exact request until the matching create completes', async () => {
    const userDataPath = await createUserDataPath()
    const sourceKey = String.raw`C:\repo\report.html`
    const first = getOrCreateArtifactCreateIntent(
      'local-profile',
      userDataPath,
      sourceKey,
      scope,
      'key-a',
      body
    )
    const retry = getOrCreateArtifactCreateIntent(
      'local-profile',
      userDataPath,
      sourceKey,
      scope,
      'key-b',
      { ...body, content: '<h1>Changed</h1>' }
    )

    expect(first).toEqual(retry)
    expect(retry).toMatchObject({ idempotencyKey: 'key-a', body })
    removeArtifactCreateIntent('local-profile', userDataPath, sourceKey, scope, 'key-b')
    expect(getArtifactCreateIntent('local-profile', userDataPath, sourceKey, scope)).not.toBeNull()
    removeArtifactCreateIntent('local-profile', userDataPath, sourceKey, scope, 'key-a')
    expect(getArtifactCreateIntent('local-profile', userDataPath, sourceKey, scope)).toBeNull()
  })

  it.each([
    ['user', { cloudUserId: 'user-b' }],
    ['profile', { cloudProfileId: 'cloud-b' }],
    ['organization', { cloudOrganizationId: 'org-b' }],
    ['API origin', { apiOrigin: 'http://localhost:3000' }]
  ])('isolates recovery intent by %s', async (_name, changedScope) => {
    const userDataPath = await createUserDataPath()
    const sourceKey = '/repo/report.html'
    getOrCreateArtifactCreateIntent('local-profile', userDataPath, sourceKey, scope, 'key-a', body)

    expect(
      getArtifactCreateIntent('local-profile', userDataPath, sourceKey, {
        ...scope,
        ...changedScope
      })
    ).toBeNull()
  })

  it('bounds unresolved payload storage without dropping an existing intent', async () => {
    const userDataPath = await createUserDataPath()
    for (let index = 0; index < MAX_PENDING_ARTIFACT_CREATES; index += 1) {
      getOrCreateArtifactCreateIntent(
        'local-profile',
        userDataPath,
        `/repo/report-${index}.html`,
        scope,
        `key-${index}`,
        body
      )
    }

    expect(() =>
      getOrCreateArtifactCreateIntent(
        'local-profile',
        userDataPath,
        '/repo/overflow.html',
        scope,
        'overflow-key',
        body
      )
    ).toThrow(/waiting for recovery/)
    expect(
      getOrCreateArtifactCreateIntent(
        'local-profile',
        userDataPath,
        '/repo/report-0.html',
        scope,
        'replacement-key',
        { ...body, content: 'replacement' }
      ).idempotencyKey
    ).toBe('key-0')
  })

  it('clears pending content at the profile lifecycle boundary', async () => {
    const userDataPath = await createUserDataPath()
    getOrCreateArtifactCreateIntent(
      'local-profile',
      userDataPath,
      '/repo/report.html',
      scope,
      'key-a',
      body
    )

    clearArtifactCreateIntents('local-profile', userDataPath)

    expect(
      getArtifactCreateIntent('local-profile', userDataPath, '/repo/report.html', scope)
    ).toBeNull()
  })

  it('refuses to overwrite an unreadable matching intent', async () => {
    const userDataPath = await createUserDataPath()
    const directory = join(userDataPath, 'profiles', 'local-profile', 'artifact-create-intents')
    getOrCreateArtifactCreateIntent(
      'local-profile',
      userDataPath,
      '/repo/report.html',
      scope,
      'key-a',
      body
    )
    const [fileName] = await readdir(directory)
    await writeFile(join(directory, fileName), '{broken-json')

    expect(() =>
      getOrCreateArtifactCreateIntent(
        'local-profile',
        userDataPath,
        '/repo/report.html',
        scope,
        'key-b',
        body
      )
    ).toThrow(/could not be read safely/)
  })
})

async function createUserDataPath(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'orca-artifact-create-intents-'))
  createdPaths.push(path)
  return path
}
