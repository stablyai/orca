import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn() } }))

import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'
import { getAntigravityCliLogDirectory } from './antigravity-loopback-client'
import {
  LOCAL_HTTPS_TEST_CERTIFICATE,
  LOCAL_HTTPS_TEST_PRIVATE_KEY
} from '../../../tests/e2e/helpers/local-https-test-certificate'

const quotaSummary = {
  response: {
    groups: [
      {
        buckets: [
          { bucketId: 'gemini-weekly', remainingFraction: 0.92 },
          { bucketId: 'gemini-5h', remainingFraction: 1 },
          { bucketId: '3p-weekly', remainingFraction: 0.99 },
          { bucketId: '3p-5h', remainingFraction: 0.96 }
        ]
      }
    ]
  }
}

describe('Antigravity language-server discovery', () => {
  it('falls past a newer stale log to the live CLI quota service', async () => {
    const homePath = await mkdtemp(join(tmpdir(), 'orca-antigravity-cli-'))
    const logDirectory = getAntigravityCliLogDirectory(homePath)
    let requestBody = ''
    const server = createServer((request, response) => {
      request.on('data', (chunk: Buffer) => {
        requestBody += chunk.toString('utf8')
      })
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(quotaSummary))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP listener')
    }

    try {
      await mkdir(logDirectory, { recursive: true })
      await writeFile(
        join(logDirectory, 'cli-20260714_123131.log'),
        'Language server listening on random port at 1 for HTTP'
      )
      await writeFile(
        join(logDirectory, 'cli-20260714_103225.log'),
        `${'old log data\n'.repeat(12_000)}Language server listening on random port at ${address.port} for HTTP`
      )

      const result = await fetchAntigravityRateLimits({
        homePath,
        appDataPath: join(homePath, 'app-data')
      })

      expect(requestBody).toBe('{}')
      expect(result).toMatchObject({
        provider: 'antigravity',
        session: { usedPercent: 4 },
        weekly: { usedPercent: 8 },
        status: 'ok',
        usageMetadata: {
          source: 'live-session',
          credentialSource: 'agy-local-service',
          authProvenance: 'antigravity'
        }
      })
      expect(result.buckets).toHaveLength(4)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      await rm(homePath, { recursive: true, force: true })
    }
  })

  it.each([
    { responseName: 'not-signed-in error', statusCode: 500, body: 'not signed in' },
    { responseName: 'empty quota', statusCode: 200, body: '{"response":{"groups":[]}}' }
  ])(
    'does not fall back to an older account after the newest runtime answers with $responseName',
    async ({ statusCode, body }) => {
      const homePath = await mkdtemp(join(tmpdir(), 'orca-antigravity-account-'))
      const logDirectory = getAntigravityCliLogDirectory(homePath)
      let olderRequests = 0
      const newestServer = createServer((_request, response) => {
        response.writeHead(statusCode, { 'content-type': 'application/json' })
        response.end(body)
      })
      const olderServer = createServer((_request, response) => {
        olderRequests += 1
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(quotaSummary))
      })
      await new Promise<void>((resolve) => newestServer.listen(0, '127.0.0.1', resolve))
      await new Promise<void>((resolve) => olderServer.listen(0, '127.0.0.1', resolve))
      const newestAddress = newestServer.address()
      const olderAddress = olderServer.address()
      if (
        !newestAddress ||
        typeof newestAddress === 'string' ||
        !olderAddress ||
        typeof olderAddress === 'string'
      ) {
        throw new Error('Expected TCP listeners')
      }

      try {
        await mkdir(logDirectory, { recursive: true })
        await writeFile(
          join(logDirectory, 'cli-20260714_123131.log'),
          `Language server listening on random port at ${newestAddress.port} for HTTP`
        )
        await writeFile(
          join(logDirectory, 'cli-20260714_103225.log'),
          `Language server listening on random port at ${olderAddress.port} for HTTP`
        )

        const result = await fetchAntigravityRateLimits({
          homePath,
          appDataPath: join(homePath, 'app-data')
        })

        expect(result).toMatchObject({
          provider: 'antigravity',
          status: 'error',
          usageMetadata: { failureKind: 'usage-unavailable' }
        })
        expect(olderRequests).toBe(0)
      } finally {
        await Promise.all([
          new Promise<void>((resolve) => newestServer.close(() => resolve())),
          new Promise<void>((resolve) => olderServer.close(() => resolve()))
        ])
        await rm(homePath, { recursive: true, force: true })
      }
    }
  )

  it('uses desktop CSRF configuration after an unauthenticated quota response', async () => {
    const homePath = await mkdtemp(join(tmpdir(), 'orca-antigravity-desktop-'))
    const appDataPath = join(homePath, 'app-data')
    const logDirectory = join(appDataPath, 'Antigravity', 'logs')
    const requestHeaders: (string | undefined)[] = []
    const server = createHttpsServer(
      { key: LOCAL_HTTPS_TEST_PRIVATE_KEY, cert: LOCAL_HTTPS_TEST_CERTIFICATE },
      (request, response) => {
        if (request.url === '/') {
          response.writeHead(200)
          response.end(
            '<script>window.__APP_CONFIG__ = {"productName":"antigravity","csrfToken":"desktop-token"};</script>'
          )
          return
        }
        requestHeaders.push(request.headers['x-codeium-csrf-token'] as string | undefined)
        if (request.headers['x-codeium-csrf-token'] !== 'desktop-token') {
          response.writeHead(403)
          response.end()
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(quotaSummary))
      }
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP listener')
    }

    try {
      await mkdir(logDirectory, { recursive: true })
      await writeFile(
        join(logDirectory, 'language_server.log'),
        `Language server listening on random port at ${address.port} for HTTPS`
      )

      const result = await fetchAntigravityRateLimits({
        homePath,
        appDataPath,
        platform: 'linux'
      })

      expect(result.status).toBe('ok')
      expect(requestHeaders).toEqual([undefined, 'desktop-token'])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(homePath, { recursive: true, force: true })
    }
  })

  it('reports unavailable when no local runtime can be discovered', async () => {
    const homePath = await mkdtemp(join(tmpdir(), 'orca-antigravity-missing-'))
    try {
      await expect(
        fetchAntigravityRateLimits({
          homePath,
          appDataPath: join(homePath, 'app-data')
        })
      ).resolves.toMatchObject({
        provider: 'antigravity',
        status: 'unavailable',
        usageMetadata: { failureKind: 'cli-unavailable' }
      })
    } finally {
      await rm(homePath, { recursive: true, force: true })
    }
  })

  it('honors service cancellation before starting discovery', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(fetchAntigravityRateLimits({ signal: controller.signal })).rejects.toThrow(
      /aborted/i
    )
  })

  it('aborts an in-flight loopback request', async () => {
    const homePath = await mkdtemp(join(tmpdir(), 'orca-antigravity-abort-'))
    const logDirectory = getAntigravityCliLogDirectory(homePath)
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const server = createServer(() => markStarted?.())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP listener')
    }
    const controller = new AbortController()

    try {
      await mkdir(logDirectory, { recursive: true })
      await writeFile(
        join(logDirectory, 'cli-20260714_123131.log'),
        `Language server listening on random port at ${address.port} for HTTP`
      )
      const fetchResult = fetchAntigravityRateLimits({
        signal: controller.signal,
        homePath,
        appDataPath: join(homePath, 'app-data')
      })
      await started
      controller.abort()

      await expect(fetchResult).rejects.toThrow(/aborted/i)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(homePath, { recursive: true, force: true })
    }
  })
})
