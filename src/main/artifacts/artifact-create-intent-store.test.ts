import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ARTIFACT_CLI_MAX_RPC_BYTES, artifactWriteRequestByteLength } from '../../shared/artifacts'
import {
  MAX_ARTIFACT_CREATE_INTENT_BYTES,
  MAX_PENDING_ARTIFACT_CREATES,
  clearArtifactCreateIntents,
  getArtifactCreateIntent,
  getOrCreateArtifactCreateIntent,
  removeArtifactCreateIntent
} from './artifact-create-intent-store'
import type { ArtifactShareScope } from './artifact-share-record-store'

vi.mock('node:child_process', () => ({ execFile: vi.fn(), execFileSync: vi.fn() }))

const createdPaths: string[] = []
const scope: ArtifactShareScope = {
  cloudUserId: 'user-a',
  cloudProfileId: 'cloud-a',
  cloudOrganizationId: 'org-a',
  apiOrigin: 'https://share.onorca.dev'
}
const body = {
  content: '<h1>Original</h1>',
  contentType: 'text/html' as const,
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
    const directory = join(userDataPath, 'profiles', 'local-profile', 'artifact-create-intents')
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
    expect(await readdir(directory)).toEqual([])
  })

  it('removes crash-left temporary writes before admitting another intent', async () => {
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
    removeArtifactCreateIntent('local-profile', userDataPath, '/repo/report.html', scope, 'key-a')
    await writeFile(join(directory, 'crash-left.tmp'), 'partial')

    getOrCreateArtifactCreateIntent(
      'local-profile',
      userDataPath,
      '/repo/other.html',
      scope,
      'key-b',
      body
    )

    expect((await readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('hardens one Windows journal directory without per-file PowerShell launches', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.mocked(execFileSync).mockImplementation((file) =>
      String(file).endsWith('whoami.exe') ? '"USER","S-1-5-21-1000"' : ''
    )
    try {
      const userDataPath = await createUserDataPath()
      getOrCreateArtifactCreateIntent(
        'local-profile',
        userDataPath,
        '/repo/report.html',
        scope,
        'key-a',
        body
      )
      getOrCreateArtifactCreateIntent(
        'local-profile',
        userDataPath,
        '/repo/other.html',
        scope,
        'key-b',
        body
      )

      const powershellCalls = vi
        .mocked(execFileSync)
        .mock.calls.filter(([file]) => String(file).endsWith('powershell.exe'))
      expect(powershellCalls).toHaveLength(1)
      expect((powershellCalls[0]![1] as string[]).at(-1)).toBe('1')
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
      vi.mocked(execFileSync).mockReset()
    }
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

  it('removes an unreadable intent after its mutation completes', async () => {
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
      removeArtifactCreateIntent('local-profile', userDataPath, '/repo/report.html', scope, 'key-a')
    ).not.toThrow()
    expect(await readdir(directory)).toEqual([])
  })

  it('rejects a persisted content type outside the artifact allowlist', async () => {
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
    const path = join(directory, fileName)
    const intent = JSON.parse(await readFile(path, 'utf8')) as { body: { contentType: string } }
    intent.body.contentType = 'application/octet-stream'
    await writeFile(path, JSON.stringify(intent))

    expect(() =>
      getArtifactCreateIntent('local-profile', userDataPath, '/repo/report.html', scope)
    ).toThrow(/unsupported format/)
  })

  it('persists a valid artifact request near the RPC limit', async () => {
    const userDataPath = await createUserDataPath()
    const nearLimitBody = { ...body, content: 'x'.repeat(ARTIFACT_CLI_MAX_RPC_BYTES - 200) }
    expect(
      artifactWriteRequestByteLength({ sourceKey: '/repo/report.html', ...nearLimitBody })
    ).toBeLessThanOrEqual(ARTIFACT_CLI_MAX_RPC_BYTES)

    expect(() =>
      getOrCreateArtifactCreateIntent(
        'local-profile',
        userDataPath,
        '/repo/report.html',
        scope,
        'key-a',
        nearLimitBody
      )
    ).not.toThrow()
    const directory = join(userDataPath, 'profiles', 'local-profile', 'artifact-create-intents')
    const [fileName] = await readdir(directory)
    expect((await stat(join(directory, fileName))).size).toBeGreaterThan(ARTIFACT_CLI_MAX_RPC_BYTES)
  })

  it('rejects an oversized recovery record before reading it', async () => {
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
    await truncate(join(directory, fileName), MAX_ARTIFACT_CREATE_INTENT_BYTES + 1)

    expect(() =>
      getArtifactCreateIntent('local-profile', userDataPath, '/repo/report.html', scope)
    ).toThrow(/exceeds the supported size/)
  })
})

async function createUserDataPath(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'orca-artifact-create-intents-'))
  createdPaths.push(path)
  return path
}
