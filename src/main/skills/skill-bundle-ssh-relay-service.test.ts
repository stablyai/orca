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
    const secondRpc = vi.fn(async (method: string) =>
      method === 'relay.status' ? { capabilities: ['skills.install.bundle.v1'] } : result()
    )
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
    expect(secondRpc.mock.calls.map(([method]) => method)).toEqual([
      'relay.status',
      'skills.installBundle'
    ])
  })

  it('does not reuse newer capabilities after reconnecting to an older host', async () => {
    const secondRpc = vi.fn(async (_method: string) => ({
      capabilities: ['skills.install.v1']
    }))
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
    ).rejects.toThrow('skill-bundle-ssh-update-required')
    expect(secondRpc.mock.calls.map(([method]) => method)).toEqual(['relay.status'])
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
      'relay.status',
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

  it('falls back to bounded per-skill previews on an older SSH host', async () => {
    const request = previewRequest()
    let active = 0
    let maximumActive = 0
    const requestHostRpc = vi.fn(async (method: string, params: unknown) => {
      if (method === 'relay.status') {
        return { capabilities: ['skills.manage.v1'] }
      }
      if (method !== 'skills.previewInstall') {
        throw new Error(`unexpected method ${method}`)
      }
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      active -= 1
      const input = params as { request: { name: string; package: { packageDigest: string } } }
      return {
        packageDigest: input.request.package.packageDigest,
        name: input.request.name,
        destinationIdentity: 'global:ssh-host',
        currentState: 'missing',
        providers: []
      }
    })

    await expect(
      previewSkillBundleInstallOnSshHost({
        provider: { requestHostRpc } as unknown as IPtyProvider,
        request
      })
    ).resolves.toEqual({
      packageId: request.package.packageId,
      versionId: request.package.versionId,
      bundleDigest: request.package.bundleDigest,
      destinationIdentity: 'global:ssh-host',
      skills: request.selectedSkills.map((skill) => ({ ...skill, currentState: 'missing' }))
    })
    expect(requestHostRpc.mock.calls.map(([method]) => method)).not.toContain(
      'skills.previewBundleInstall'
    )
    expect(requestHostRpc).toHaveBeenCalledTimes(request.selectedSkills.length + 1)
    expect(maximumActive).toBeLessThanOrEqual(8)
  })

  it('settles a failed legacy batch before retrying it', async () => {
    let active = 0
    let cancelled = 0
    let maximumActive = 0
    const requestHostRpc = vi.fn(
      async (method: string, params: unknown, options?: { signal?: AbortSignal }) => {
        if (method === 'relay.status') {
          return { capabilities: ['skills.manage.v1'] }
        }
        const input = params as { request: { name: string; package: { packageDigest: string } } }
        active += 1
        maximumActive = Math.max(maximumActive, active)
        try {
          if (input.request.name === 'skill-0') {
            throw new Error('preview transport failed')
          }
          await new Promise<void>((_resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('preview cancellation timeout')), 250)
            options?.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timeout)
                cancelled += 1
                const error = new Error('preview aborted')
                error.name = 'AbortError'
                reject(error)
              },
              { once: true }
            )
          })
          return {
            packageDigest: input.request.package.packageDigest,
            name: input.request.name,
            destinationIdentity: 'global:ssh-host',
            currentState: 'missing',
            providers: []
          }
        } finally {
          active -= 1
        }
      }
    )

    await expect(
      previewSkillBundleInstallOnSshHost({
        provider: { requestHostRpc } as unknown as IPtyProvider,
        request: previewRequest()
      })
    ).rejects.toThrow('preview transport failed')

    expect(maximumActive).toBeLessThanOrEqual(8)
    expect(active).toBe(0)
    expect(cancelled).toBe(21)
  })

  it('does not retry malformed legacy preview responses', async () => {
    const requestHostRpc = vi.fn(async (method: string) =>
      method === 'relay.status' ? { capabilities: ['skills.manage.v1'] } : { malformed: true }
    )

    await expect(
      previewSkillBundleInstallOnSshHost({
        provider: { requestHostRpc } as unknown as IPtyProvider,
        request: previewRequest(8)
      })
    ).rejects.toThrow()

    expect(requestHostRpc).toHaveBeenCalledTimes(9)
  })

  it('preserves first-rejection retry semantics while settling a legacy batch', async () => {
    const nonRetryable = Object.assign(new Error('preview rejected'), { code: 400 })
    const requestHostRpc = vi.fn(async (method: string, params: unknown) => {
      if (method === 'relay.status') {
        return { capabilities: ['skills.manage.v1'] }
      }
      const input = params as { request: { name: string } }
      if (input.request.name === 'skill-0') {
        await new Promise((resolve) => setTimeout(resolve, 5))
        throw new Error('later transport failure')
      }
      throw nonRetryable
    })

    await expect(
      previewSkillBundleInstallOnSshHost({
        provider: { requestHostRpc } as unknown as IPtyProvider,
        request: previewRequest(2)
      })
    ).rejects.toThrow('preview rejected')

    expect(requestHostRpc).toHaveBeenCalledTimes(3)
  })

  it('requires an update when the SSH host lacks both preview capabilities', async () => {
    const requestHostRpc = vi.fn(async () => ({ capabilities: [] }))

    await expect(
      previewSkillBundleInstallOnSshHost({
        provider: { requestHostRpc } as unknown as IPtyProvider,
        request: previewRequest()
      })
    ).rejects.toThrow('skill-bundle-ssh-update-required')
    expect(requestHostRpc).toHaveBeenCalledOnce()
  })

  it('adopts the current provider generation when preview retries after reconnect', async () => {
    const request = previewRequest()
    const response = {
      packageId: request.package.packageId,
      versionId: request.package.versionId,
      bundleDigest: request.package.bundleDigest,
      destinationIdentity: 'global:ssh-host',
      skills: request.selectedSkills.map((skill) => ({
        ...skill,
        currentState: 'missing' as const
      }))
    }
    const secondRpc = vi.fn(async (method: string) =>
      method === 'relay.status' ? { capabilities: ['skills.preview.bundle.v1'] } : response
    )
    const secondProvider = { requestHostRpc: secondRpc } as unknown as IPtyProvider
    let currentProvider: IPtyProvider
    const firstRpc = vi.fn(async (method: string) => {
      if (method === 'relay.status') {
        return { capabilities: ['skills.preview.bundle.v1'] }
      }
      currentProvider = secondProvider
      throw new Error('disconnected-provider-generation')
    })
    currentProvider = { requestHostRpc: firstRpc } as unknown as IPtyProvider

    await expect(
      previewSkillBundleInstallOnSshHost({ provider: () => currentProvider, request })
    ).resolves.toEqual(response)
    expect(firstRpc.mock.calls.map(([method]) => method)).toEqual([
      'relay.status',
      'skills.previewBundleInstall'
    ])
    expect(secondRpc.mock.calls.map(([method]) => method)).toEqual([
      'relay.status',
      'skills.previewBundleInstall'
    ])
  })
})
