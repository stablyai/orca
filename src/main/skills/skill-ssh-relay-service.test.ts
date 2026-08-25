import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SKILL_PACKAGE_CONTENT_TYPE } from '../../shared/skill-package-manifest'
import type { IPtyProvider } from '../providers/pty-provider-contract'
import { installSkillOnSshHost } from './skill-ssh-relay-service'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function userDataPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-ssh-client-test-'))
  roots.push(root)
  return root
}

function result() {
  return {
    operationId: 'operation_1',
    status: 'installed' as const,
    name: 'ssh-skill',
    packageDigest: 'a'.repeat(64),
    placements: []
  }
}

function request(bytes: Buffer) {
  return {
    operationId: 'operation_1',
    package: {
      packageId: 'package_1',
      versionId: 'version_1',
      packageDigest: 'a'.repeat(64),
      archiveSha256: createHash('sha256').update(bytes).digest('hex'),
      compressedBytes: bytes.length
    },
    ingress: {
      kind: 'download-grant' as const,
      url: 'https://storage.googleapis.com/test/package.tar.gz',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    },
    destination: { scope: 'global' as const, executionTarget: { kind: 'host' as const } }
  }
}

describe('installSkillOnSshHost', () => {
  it('does not reuse newer capabilities after reconnecting to an older host', async () => {
    const secondRpc = vi.fn(async (_method: string) => ({ capabilities: [] }))
    const secondProvider = { requestHostRpc: secondRpc } as unknown as IPtyProvider
    let currentProvider: IPtyProvider
    const firstRpc = vi.fn(async (method: string) => {
      if (method === 'relay.status') {
        return { capabilities: ['skills.install.v1'] }
      }
      currentProvider = secondProvider
      throw new Error('disconnected-provider-generation')
    })
    currentProvider = { requestHostRpc: firstRpc } as unknown as IPtyProvider

    await expect(
      installSkillOnSshHost({
        provider: () => currentProvider,
        userDataPath: await userDataPath(),
        request: request(Buffer.from('archive')),
        requireHttps: true
      })
    ).rejects.toThrow('skill-install-ssh-update-required')
    expect(secondRpc.mock.calls.map(([method]) => method)).toEqual(['relay.status'])
  })

  it('requires a relay update before sending an explicit provider choice', async () => {
    const requestHostRpc = vi.fn(async () => ({ capabilities: ['skills.install.v1'] }))
    await expect(
      installSkillOnSshHost({
        provider: { requestHostRpc } as unknown as IPtyProvider,
        userDataPath: await userDataPath(),
        request: { ...request(Buffer.from('archive')), providers: ['claude'] },
        requireHttps: true
      })
    ).rejects.toThrow('skill-install-ssh-update-required')
    expect(requestHostRpc).toHaveBeenCalledOnce()
  })

  it('uses client-mediated upload only after direct host download fails', async () => {
    const bytes = Buffer.from('private skill archive')
    let received = 0
    let beginAttempts = 0
    const beginRequests: unknown[] = []
    let chunkAttempts = 0
    let commitAttempts = 0
    const requestHostRpc = vi.fn(async (method: string, params: unknown) => {
      if (method === 'relay.status') {
        return {
          capabilities: ['skills.install.v1', 'skills.upload.v1', 'skills.manage.v1']
        }
      }
      if (method === 'skills.install') {
        const ingress = (params as { request: ReturnType<typeof request> }).request.ingress
        if (ingress.kind === 'download-grant') {
          throw Object.assign(new Error('skill-download-transport-failed'), { code: -32000 })
        }
        return result()
      }
      if (method === 'skills.beginUpload') {
        beginRequests.push(params)
        beginAttempts += 1
        if (beginAttempts === 1) {
          throw new Error('connection dropped after receiver began upload')
        }
        return { uploadId: 'upload_1', chunkBytes: 256 * 1024 }
      }
      if (method === 'skills.uploadChunk') {
        chunkAttempts += 1
        const chunk = params as { offset: number; bytesBase64: string }
        received = chunk.offset + Buffer.from(chunk.bytesBase64, 'base64').length
        if (chunkAttempts === 1) {
          throw new Error('connection dropped after receiver write')
        }
        return { acknowledgedOffset: received }
      }
      if (method === 'skills.commitUpload') {
        commitAttempts += 1
        if (commitAttempts === 1) {
          throw new Error('connection dropped after receiver commit')
        }
        return { ok: true }
      }
      if (method === 'skills.cancelUpload') {
        return { ok: true }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(
      installSkillOnSshHost({
        provider: { requestHostRpc } as unknown as IPtyProvider,
        userDataPath: await userDataPath(),
        request: request(bytes),
        requireHttps: true,
        fetcher: vi.fn(
          async () =>
            new Response(bytes, { headers: { 'content-type': SKILL_PACKAGE_CONTENT_TYPE } })
        ) as typeof fetch
      })
    ).resolves.toEqual(result())
    expect(received).toBe(bytes.length)
    expect(beginRequests).toEqual([
      expect.objectContaining({ transferId: 'operation_1' }),
      expect.objectContaining({ transferId: 'operation_1' })
    ])
    expect(requestHostRpc.mock.calls.map(([method]) => method)).toEqual([
      'relay.status',
      'skills.install',
      'relay.status',
      'skills.beginUpload',
      'skills.beginUpload',
      'skills.uploadChunk',
      'skills.uploadChunk',
      'skills.commitUpload',
      'skills.commitUpload',
      'skills.install',
      'skills.cancelUpload'
    ])
  })

  it('does not call unknown install methods on an old relay', async () => {
    const requestHostRpc = vi.fn(async () => ({ capabilities: [] }))
    await expect(
      installSkillOnSshHost({
        provider: { requestHostRpc } as unknown as IPtyProvider,
        userDataPath: await userDataPath(),
        request: request(Buffer.from('archive')),
        requireHttps: true
      })
    ).rejects.toThrow('skill-install-ssh-update-required')
    expect(requestHostRpc).toHaveBeenCalledOnce()
  })

  it('retries an idempotent direct install after its response is lost', async () => {
    const bytes = Buffer.from('private skill archive')
    let installAttempts = 0
    const requestHostRpc = vi.fn(async (method: string) => {
      if (method === 'relay.status') {
        return { capabilities: ['skills.install.v1', 'skills.upload.v1'] }
      }
      if (method === 'skills.install') {
        installAttempts += 1
        if (installAttempts === 1) {
          throw new Error('connection dropped after host commit')
        }
        return { ...result(), status: 'unchanged' }
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(
      installSkillOnSshHost({
        provider: { requestHostRpc } as unknown as IPtyProvider,
        userDataPath: await userDataPath(),
        request: request(bytes),
        requireHttps: true
      })
    ).resolves.toMatchObject({ status: 'unchanged' })
    expect(installAttempts).toBe(2)
  })

  it('rebuilds a staged transfer after the install response is lost', async () => {
    const bytes = Buffer.from('private skill archive')
    let uploadSequence = 0
    let stagedInstallAttempts = 0
    const requestHostRpc = vi.fn(async (method: string, params: unknown) => {
      if (method === 'relay.status') {
        return { capabilities: ['skills.install.v1', 'skills.upload.v1'] }
      }
      if (method === 'skills.install') {
        const ingress = (params as { request: ReturnType<typeof request> }).request.ingress
        if (ingress.kind === 'download-grant') {
          throw Object.assign(new Error('skill-download-transport-failed'), { code: -32000 })
        }
        stagedInstallAttempts += 1
        if (stagedInstallAttempts === 1) {
          throw new Error('connection dropped after staged host commit')
        }
        return { ...result(), status: 'unchanged' }
      }
      if (method === 'skills.beginUpload') {
        uploadSequence += 1
        return { uploadId: `upload_${uploadSequence}`, chunkBytes: 256 * 1024 }
      }
      if (method === 'skills.uploadChunk') {
        const chunk = params as { offset: number; bytesBase64: string }
        return {
          acknowledgedOffset: chunk.offset + Buffer.from(chunk.bytesBase64, 'base64').length
        }
      }
      return { ok: true }
    })

    await expect(
      installSkillOnSshHost({
        provider: { requestHostRpc } as unknown as IPtyProvider,
        userDataPath: await userDataPath(),
        request: request(bytes),
        requireHttps: true,
        fetcher: vi.fn(
          async () =>
            new Response(bytes, { headers: { 'content-type': SKILL_PACKAGE_CONTENT_TYPE } })
        ) as typeof fetch
      })
    ).resolves.toMatchObject({ status: 'unchanged' })
    expect(uploadSequence).toBe(2)
    expect(stagedInstallAttempts).toBe(2)
  })

  it('uses a configured development origin through the client', async () => {
    const bytes = Buffer.from('private development archive')
    const requestHostRpc = vi.fn(async (method: string, params: unknown) => {
      if (method === 'relay.status') {
        return { capabilities: ['skills.install.v1', 'skills.upload.v1'] }
      }
      if (method === 'skills.install') {
        const ingress = (params as { request: ReturnType<typeof request> }).request.ingress
        if (ingress.kind === 'download-grant') {
          throw Object.assign(new Error('skill-download-url-rejected'), { code: -32000 })
        }
        return result()
      }
      if (method === 'skills.beginUpload') {
        return { uploadId: 'upload_1', chunkBytes: 256 * 1024 }
      }
      if (method === 'skills.uploadChunk') {
        const chunk = params as { offset: number; bytesBase64: string }
        return {
          acknowledgedOffset: chunk.offset + Buffer.from(chunk.bytesBase64, 'base64').length
        }
      }
      return { ok: true }
    })

    await expect(
      installSkillOnSshHost({
        provider: { requestHostRpc } as unknown as IPtyProvider,
        userDataPath: await userDataPath(),
        request: request(bytes),
        requireHttps: false,
        fetcher: vi.fn(
          async () =>
            new Response(bytes, { headers: { 'content-type': SKILL_PACKAGE_CONTENT_TYPE } })
        ) as typeof fetch
      })
    ).resolves.toEqual(result())
  })
})
