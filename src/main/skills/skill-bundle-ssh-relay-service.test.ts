import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  SkillBundleInstallPreviewRequest,
  SkillBundleInstallRequest
} from '../../shared/skill-bundle-install-contract'
import { SKILL_PACKAGE_CONTENT_TYPE } from '../../shared/skill-package-manifest'
import type { IPtyProvider } from '../providers/pty-provider-contract'
import {
  installSkillBundleOnSshHost,
  previewSkillBundleInstallOnSshHost
} from './skill-bundle-ssh-relay-service'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function userDataPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-bundle-ssh-client-test-'))
  roots.push(root)
  return root
}

function request(bytes: Buffer): SkillBundleInstallRequest {
  return {
    operationId: 'bundle-operation',
    package: {
      packageId: 'package_1',
      versionId: 'version_1',
      bundleDigest: 'a'.repeat(64),
      archiveSha256: createHash('sha256').update(bytes).digest('hex'),
      compressedBytes: bytes.length
    },
    selectedSkillIds: ['skill-1'],
    ingress: {
      kind: 'download-grant',
      url: 'https://storage.googleapis.com/test/bundle.tar.gz',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    },
    destination: { scope: 'global', executionTarget: { kind: 'host' } },
    conflictDecisions: []
  }
}

function result() {
  return {
    operationId: 'bundle-operation',
    packageId: 'package_1',
    versionId: 'version_1',
    bundleDigest: 'a'.repeat(64),
    status: 'complete' as const,
    skills: []
  }
}

function previewRequest(count = 30): SkillBundleInstallPreviewRequest {
  return {
    package: {
      packageId: 'package_1',
      versionId: 'version_1',
      bundleDigest: 'a'.repeat(64),
      archiveSha256: 'b'.repeat(64),
      compressedBytes: 100
    },
    selectedSkills: Array.from({ length: count }, (_, index) => ({
      id: `skill-${index}`,
      name: `skill-${index}`,
      digest: String(index).padStart(64, '0')
    })),
    destination: { scope: 'global', executionTarget: { kind: 'host' } }
  }
}

describe('installSkillBundleOnSshHost', () => {
  it('adopts the current provider generation when an RPC retry follows reconnect', async () => {
    const secondRpc = vi.fn(async () => result())
    const secondProvider = { requestHostRpc: secondRpc } as unknown as IPtyProvider
    let currentProvider: IPtyProvider
    const firstRpc = vi.fn(async (method: string) => {
      if (method === 'relay.status') {
        return { capabilities: ['skills.install.bundle.v1'] }
      }
      currentProvider = secondProvider
      throw new Error('disconnected-provider-generation')
    })
    currentProvider = { requestHostRpc: firstRpc } as unknown as IPtyProvider

    await expect(
      installSkillBundleOnSshHost({
        provider: () => currentProvider,
        userDataPath: await userDataPath(),
        request: request(Buffer.from('archive')),
        requireHttps: true
      })
    ).resolves.toEqual(result())

    expect(firstRpc.mock.calls.map(([method]) => method)).toEqual([
      'relay.status',
      'skills.installBundle'
    ])
    expect(secondRpc).toHaveBeenCalledOnce()
  })

  it('uses the additive method only when advertised by the SSH host', async () => {
    const bytes = Buffer.from('private bundle archive')
    const requestHostRpc = vi.fn(async (method: string) => {
      if (method === 'relay.status') {
        return { capabilities: ['skills.install.bundle.v1'] }
      }
      if (method === 'skills.installBundle') {
        return result()
      }
      throw new Error(`unexpected method ${method}`)
    })

    await expect(
      installSkillBundleOnSshHost({
        provider: { requestHostRpc } as unknown as IPtyProvider,
        userDataPath: await userDataPath(),
        request: request(bytes),
        requireHttps: true
      })
    ).resolves.toEqual(result())
  })

  it('does not send an unknown method to an older SSH host', async () => {
    const requestHostRpc = vi.fn(async () => ({ capabilities: ['skills.install.v1'] }))

    await expect(
      installSkillBundleOnSshHost({
        provider: { requestHostRpc } as unknown as IPtyProvider,
        userDataPath: await userDataPath(),
        request: request(Buffer.from('archive')),
        requireHttps: true
      })
    ).rejects.toThrow('skill-bundle-ssh-update-required')
    expect(requestHostRpc).toHaveBeenCalledOnce()
  })

  it('polls current-skill progress only when the SSH host advertises it', async () => {
    const bytes = Buffer.from('private bundle archive')
    const onProgress = vi.fn()
    const progress = {
      operationId: 'bundle-operation',
      skillId: 'skill-1',
      skillName: 'alpha',
      skillIndex: 1,
      skillCount: 30
    }
    const requestHostRpc = vi.fn(async (method: string) => {
      if (method === 'relay.status') {
        return {
          capabilities: ['skills.install.bundle.v1', 'skills.install-progress.v1']
        }
      }
      if (method === 'skills.getInstallProgress') {
        return progress
      }
      if (method === 'skills.installBundle') {
        await new Promise((resolve) => setTimeout(resolve, 0))
        return result()
      }
      throw new Error(`unexpected method ${method}`)
    })

    await installSkillBundleOnSshHost({
      provider: { requestHostRpc } as unknown as IPtyProvider,
      userDataPath: await userDataPath(),
      request: request(bytes),
      requireHttps: true,
      onProgress
    })

    expect(onProgress).toHaveBeenCalledWith(progress)
    expect(requestHostRpc.mock.calls.map(([method]) => method)).toEqual([
      'relay.status',
      'skills.getInstallProgress',
      'skills.installBundle'
    ])
  })

  it('falls back to client-mediated transfer after direct download fails', async () => {
    const bytes = Buffer.from('private bundle archive')
    const requestHostRpc = vi.fn(async (method: string, params: unknown) => {
      if (method === 'relay.status') {
        return { capabilities: ['skills.install.bundle.v1', 'skills.upload.v1'] }
      }
      if (method === 'skills.installBundle') {
        const ingress = (params as { request: SkillBundleInstallRequest }).request.ingress
        if (ingress.kind === 'download-grant') {
          throw Object.assign(new Error('skill-download-transport-failed'), { code: -32000 })
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
      installSkillBundleOnSshHost({
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
    expect(requestHostRpc.mock.calls.map(([method]) => method)).toEqual([
      'relay.status',
      'skills.installBundle',
      'skills.beginUpload',
      'skills.uploadChunk',
      'skills.commitUpload',
      'skills.installBundle',
      'skills.cancelUpload'
    ])
  })
})

describe('previewSkillBundleInstallOnSshHost', () => {
  it('previews the complete bundle with one capability check and one RPC', async () => {
    const request = previewRequest()
    const response = {
      packageId: request.package.packageId,
      versionId: request.package.versionId,
      bundleDigest: request.package.bundleDigest,
      destinationIdentity: 'global:ssh-host',
      skills: request.selectedSkills.map((skill) => ({ ...skill, currentState: 'missing' }))
    }
    const requestHostRpc = vi.fn(async (method: string) =>
      method === 'relay.status' ? { capabilities: ['skills.preview.bundle.v1'] } : response
    )

    await expect(
      previewSkillBundleInstallOnSshHost({
        provider: { requestHostRpc } as unknown as IPtyProvider,
        request
      })
    ).resolves.toEqual(response)
    expect(requestHostRpc.mock.calls.map(([method]) => method)).toEqual([
      'relay.status',
      'skills.previewBundleInstall'
    ])
  })

  it('does not send an unknown preview method to an older SSH host', async () => {
    const requestHostRpc = vi.fn(async () => ({ capabilities: ['skills.manage.v1'] }))

    await expect(
      previewSkillBundleInstallOnSshHost({
        provider: { requestHostRpc } as unknown as IPtyProvider,
        request: previewRequest()
      })
    ).rejects.toThrow('skill-bundle-ssh-update-required')
    expect(requestHostRpc).toHaveBeenCalledOnce()
  })
})
