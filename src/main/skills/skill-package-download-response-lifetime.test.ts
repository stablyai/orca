import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SKILL_PACKAGE_CONTENT_TYPE } from '../../shared/skill-package-manifest'
import { downloadSkillPackageGrant } from './skill-package-download'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, open: vi.fn(actual.open) }
})

const roots: string[] = []
const packageBytes = gzipSync(Buffer.from('downloaded package bytes'))
const archiveSha256 = createHash('sha256').update(packageBytes).digest('hex')

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function downloadRoot(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'orca-skill-response-lifetime-'))
  roots.push(root)
  return root
}

async function storageServer(respond: (path: string, response: ServerResponse) => void) {
  const streaming = new Set<ServerResponse>()
  const server = createServer((request, response) => {
    respond(request.url ?? '/', response)
    if (response.writableEnded) {
      return
    }
    streaming.add(response)
    response.write(Buffer.alloc(1024))
    const timer = setInterval(() => response.write(Buffer.alloc(1024)), 10)
    response.once('close', () => {
      clearInterval(timer)
      streaming.delete(response)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('storage server did not bind')
  }
  const origin = `http://127.0.0.1:${address.port}`
  return {
    origin,
    streaming,
    async close(): Promise<void> {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

async function downloadInput(origin: string) {
  return {
    url: `${origin}/package`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    expectedArchiveSha256: archiveSha256,
    expectedCompressedBytes: packageBytes.length,
    temporaryRoot: await downloadRoot(),
    allowedOrigins: [origin],
    requireHttps: false
  }
}

describe('skill download response ownership', () => {
  it.each([
    { kind: 'http-error', error: 'skill-download-transport-failed' },
    { kind: 'content-type', error: 'skill-download-content-type-invalid' },
    { kind: 'content-length', error: 'skill-download-size-mismatch' },
    { kind: 'staging-directory', error: /EEXIST|ENOTDIR/ },
    { kind: 'archive-open', error: 'archive open failed' }
  ])('closes an unread streaming response after $kind failure', async ({ kind, error }) => {
    const storage = await storageServer((_path, response) => {
      response.writeHead(kind === 'http-error' ? 403 : 200, {
        'content-type': kind === 'content-type' ? 'text/html' : SKILL_PACKAGE_CONTENT_TYPE,
        ...(kind === 'content-length' ? { 'content-length': '41943040' } : {})
      })
    })
    try {
      const input = await downloadInput(storage.origin)
      if (kind === 'staging-directory') {
        input.temporaryRoot = join(input.temporaryRoot, 'file')
        await fs.writeFile(input.temporaryRoot, 'not a directory')
      }
      if (kind === 'archive-open') {
        vi.mocked(fs.open).mockRejectedValueOnce(new Error('archive open failed'))
      }
      await expect(downloadSkillPackageGrant(input)).rejects.toThrow(error)
      await vi.waitFor(() => expect(storage.streaming.size).toBe(0))
    } finally {
      await storage.close()
    }
  })

  it.each([
    { kind: 'allowed', error: null },
    { kind: 'cross-origin', error: 'skill-download-cross-origin-redirect' },
    { kind: 'missing-location', error: 'skill-download-redirect-invalid' },
    { kind: 'redirect-limit', error: 'skill-download-redirect-limit' }
  ])('closes unread $kind redirect bodies', async ({ kind, error }) => {
    const storage = await storageServer((path, response) => {
      if (path === '/final') {
        response.writeHead(200, { 'content-type': SKILL_PACKAGE_CONTENT_TYPE })
        response.end(packageBytes)
        return
      }
      response.writeHead(
        307,
        kind === 'missing-location'
          ? {}
          : {
              location:
                kind === 'cross-origin'
                  ? 'http://localhost:1/package'
                  : kind === 'redirect-limit'
                    ? '/package'
                    : '/final'
            }
      )
    })
    try {
      const input = await downloadInput(storage.origin)
      input.allowedOrigins.push('http://localhost:1')
      if (error) {
        await expect(downloadSkillPackageGrant(input)).rejects.toThrow(error)
      } else {
        const result = await downloadSkillPackageGrant(input)
        expect(await fs.readFile(result.archivePath)).toEqual(packageBytes)
        expect(result.archiveSha256).toBe(archiveSha256)
        await result.cleanup()
      }
      await vi.waitFor(() => expect(storage.streaming.size).toBe(0))
    } finally {
      await storage.close()
    }
  })

  it('preserves complete downloads and checksum failures on a real streaming connection', async () => {
    const storage = await storageServer((_path, response) => {
      response.writeHead(200, { 'content-type': SKILL_PACKAGE_CONTENT_TYPE })
      response.write(packageBytes.subarray(0, 5))
      response.end(packageBytes.subarray(5))
    })
    try {
      const input = await downloadInput(storage.origin)
      const result = await downloadSkillPackageGrant(input)
      expect(result.compressedBytes).toBe(packageBytes.length)
      expect(result.archiveSha256).toBe(archiveSha256)
      expect(await fs.readFile(result.archivePath)).toEqual(packageBytes)
      await result.cleanup()
      await expect(
        downloadSkillPackageGrant({ ...input, expectedArchiveSha256: '0'.repeat(64) })
      ).rejects.toThrow('skill-download-archive-digest-mismatch')
    } finally {
      await storage.close()
    }
  })
})
