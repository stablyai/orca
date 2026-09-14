import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillCloudVersion } from '../../shared/skill-cloud-contract'
import { SkillCloudService } from './skill-cloud-service'

const { packaged } = vi.hoisted(() => ({ packaged: { value: false } }))
const createdPaths: string[] = []

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return packaged.value
    }
  }
}))

afterEach(() => {
  for (const path of createdPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
  packaged.value = false
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function userDataPath(): string {
  const path = mkdtempSync(join(tmpdir(), 'orca-skill-cloud-service-'))
  createdPaths.push(path)
  return path
}

function publishedVersion(archiveSha256: string, compressedBytes: number): SkillCloudVersion {
  return {
    packageId: 'pkg_retry',
    versionId: 'ver_retry',
    name: 'retry-skill',
    description: 'Retry publication',
    packageDigest: 'a'.repeat(64),
    archiveSha256,
    compressedBytes,
    createdAt: '2026-08-12T12:00:00.000Z',
    releaseNotes: 'retry',
    manifest: {
      schemaVersion: 1,
      packageId: 'pkg_retry',
      versionId: 'ver_retry',
      name: 'retry-skill',
      description: 'Retry publication',
      createdAt: '2026-08-12T12:00:00.000Z',
      packageDigest: 'a'.repeat(64),
      files: []
    }
  }
}

function publishRequest(archivePath: string, archiveSha256: string, compressedBytes: number) {
  return {
    apiUrl: 'http://127.0.0.1:8787',
    archivePath,
    archiveSha256,
    compressedBytes,
    packageId: 'pkg_retry',
    releaseNotes: 'retry'
  }
}

describe('SkillCloudService bearer links', () => {
  it('resolves and grants downloads without an Orca session', async () => {
    const requests: RequestInit[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        requests.push(init ?? {})
        return String(input).endsWith('/download-grants')
          ? Response.json({
              grant: { url: 'https://storage.test/package', expiresAt: '2026-08-11T00:05:00Z' },
              version: { versionId: 'ver_1' }
            })
          : Response.json({ share: { id: 'share_1', version: { versionId: 'ver_1' } } })
      })
    )
    const service = new SkillCloudService('/unused')
    const options = { apiUrl: 'http://127.0.0.1:8787' }

    await expect(service.resolveShare('share_1', options)).resolves.toMatchObject({ status: 'ok' })
    await expect(service.createDownloadGrant('share_1', options)).resolves.toMatchObject({
      status: 'ok'
    })

    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(new Headers(request.headers).has('authorization')).toBe(false)
    }
  })

  it('uses the development auth token without opening a profile session', async () => {
    vi.stubEnv('ORCA_CLOUD_AUTH_TOKEN', 'desktop-e2e-token')
    const requests: RequestInit[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
        requests.push(init ?? {})
        return Response.json({ shares: [] })
      })
    )

    await expect(
      new SkillCloudService(userDataPath()).listOwnedShares({ apiUrl: 'http://127.0.0.1:8787' })
    ).resolves.toEqual({ status: 'ok', value: [] })

    expect(new Headers(requests[0]?.headers).get('authorization')).toBe('Bearer desktop-e2e-token')
  })

  it('rejects the development auth token in packaged builds', async () => {
    packaged.value = true
    vi.stubEnv('ORCA_CLOUD_AUTH_TOKEN', 'desktop-e2e-token')

    await expect(
      new SkillCloudService(userDataPath()).listOwnedShares({ apiUrl: 'https://share.onorca.dev' })
    ).rejects.toThrow('available only in development builds')
  })
})

describe('SkillCloudService publication retries', () => {
  it('reuses a reserved upload after its create response is lost', async () => {
    vi.stubEnv('ORCA_CLOUD_AUTH_TOKEN', 'desktop-e2e-token')
    const root = userDataPath()
    const archivePath = join(root, 'package.tar.gz')
    const archive = Buffer.from('skill archive')
    const archiveSha256 = 'b'.repeat(64)
    const version = publishedVersion(archiveSha256, archive.byteLength)
    writeFileSync(archivePath, archive)
    let createAttempts = 0
    let uploads = 0
    const createKeys: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/v1/skill-packages/uploads')) {
          createAttempts += 1
          createKeys.push(new Headers(init?.headers).get('idempotency-key') ?? '')
          if (createAttempts === 1) {
            throw new Error('create response lost')
          }
          return Response.json({
            upload: {
              id: 'upl_retry',
              policy: { url: 'https://storage.test/upload', fields: {}, expiresAt: '2099-01-01' }
            }
          })
        }
        if (url === 'https://storage.test/upload') {
          uploads += 1
          return new Response(null, { status: 204 })
        }
        if (url.endsWith('/v1/skill-packages/pkg_retry')) {
          return new Response(null, { status: 404 })
        }
        if (url.endsWith('/v1/skill-packages/uploads/upl_retry/finalize')) {
          return Response.json({ version })
        }
        throw new Error(`Unexpected request: ${url}`)
      })
    )
    const service = new SkillCloudService(root)
    const request = publishRequest(archivePath, archiveSha256, archive.byteLength)

    await expect(service.publishVersion(request)).rejects.toThrow('create response lost')
    await expect(service.publishVersion(request)).resolves.toEqual({ status: 'ok', value: version })

    expect(createKeys).toHaveLength(2)
    expect(new Set(createKeys).size).toBe(1)
    expect(createKeys[0]).not.toBe('')
    expect(uploads).toBe(1)
  })

  it('finds the finalized version when retrying after its response is lost', async () => {
    vi.stubEnv('ORCA_CLOUD_AUTH_TOKEN', 'desktop-e2e-token')
    const root = userDataPath()
    const archivePath = join(root, 'package.tar.gz')
    const archive = Buffer.from('skill archive')
    const archiveSha256 = 'c'.repeat(64)
    const version = publishedVersion(archiveSha256, archive.byteLength)
    writeFileSync(archivePath, archive)
    let createAttempts = 0
    let uploads = 0
    let finalizations = 0
    const createKeys: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/v1/skill-packages/uploads')) {
          createAttempts += 1
          createKeys.push(new Headers(init?.headers).get('idempotency-key') ?? '')
          if (createAttempts === 2) {
            return Response.json(
              { code: 'skill_upload_not_pending', message: 'Upload is already finalized.' },
              { status: 409 }
            )
          }
          return Response.json({
            upload: {
              id: 'upl_retry',
              policy: { url: 'https://storage.test/upload', fields: {}, expiresAt: '2099-01-01' }
            }
          })
        }
        if (url === 'https://storage.test/upload') {
          uploads += 1
          return new Response(null, { status: 204 })
        }
        if (url.endsWith('/v1/skill-packages/uploads/upl_retry/finalize')) {
          finalizations += 1
          throw new Error('finalize response lost')
        }
        if (url.endsWith('/v1/skill-packages/pkg_retry')) {
          return Response.json({
            package: {
              id: 'pkg_retry',
              name: 'retry-skill',
              description: 'Retry publication',
              createdAt: version.createdAt,
              canManage: true,
              versions: [version]
            }
          })
        }
        throw new Error(`Unexpected request: ${url}`)
      })
    )
    const service = new SkillCloudService(root)
    const request = publishRequest(archivePath, archiveSha256, archive.byteLength)

    await expect(service.publishVersion(request)).rejects.toThrow('finalize response lost')
    await expect(service.publishVersion(request)).resolves.toEqual({ status: 'ok', value: version })

    expect(createKeys).toHaveLength(2)
    expect(new Set(createKeys).size).toBe(1)
    expect(createKeys[0]).not.toBe('')
    expect(uploads).toBe(1)
    expect(finalizations).toBe(1)
  })
})
