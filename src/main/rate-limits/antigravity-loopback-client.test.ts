import { createServer } from 'node:http'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AntigravityLoopbackResponseError,
  fetchAntigravityQuotaEndpoint,
  getAntigravityCliLogDirectory,
  getAntigravityLanguageServerLogPath,
  parseAntigravityAppConfig,
  parseAntigravityCliServerPorts,
  parseAntigravityLanguageServerPort
} from './antigravity-loopback-client'

describe('Antigravity loopback client', () => {
  it('uses cross-platform CLI and desktop log paths', () => {
    expect(getAntigravityCliLogDirectory('/home/lee')).toBe(
      join('/home/lee', '.gemini', 'antigravity-cli', 'log')
    )
    expect(getAntigravityLanguageServerLogPath('darwin', '/Users/lee', '/app-data')).toBe(
      join('/Users/lee', 'Library', 'Logs', 'Antigravity', 'language_server.log')
    )
    for (const platform of ['linux', 'win32'] as const) {
      expect(getAntigravityLanguageServerLogPath(platform, '/home/lee', '/home/lee/.config')).toBe(
        join('/home/lee/.config', 'Antigravity', 'logs', 'language_server.log')
      )
    }
  })

  it('uses the newest listener announcement after a server restart', () => {
    const log = [
      'Language server listening on random port at 40100 for HTTPS (gRPC)',
      'Language server listening on fixed port at 40200 for HTTPS (gRPC)',
      'Language server listening on random port at 40201 for HTTP'
    ].join('\n')

    expect(parseAntigravityCliServerPorts(log)).toEqual({ http: 40201, https: 40200 })
    expect(parseAntigravityLanguageServerPort(log)).toBe(40200)
  })

  it('accepts only Antigravity app configuration with a CSRF token', () => {
    expect(
      parseAntigravityAppConfig(
        '<script>window.__APP_CONFIG__ = {"productName":"antigravity","csrfToken":"token"};</script>'
      )
    ).toEqual({ productName: 'antigravity', csrfToken: 'token' })
    expect(
      parseAntigravityAppConfig(
        '<script>window.__APP_CONFIG__ = {"productName":"other","csrfToken":"token"};</script>'
      )
    ).toBeNull()
  })

  it('rejects a loopback response that exceeds the byte limit', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(Buffer.alloc(1024 * 1024 + 1, 'x'))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP listener')
    }

    try {
      await expect(
        fetchAntigravityQuotaEndpoint('http:', address.port, new AbortController().signal)
      ).rejects.toBeInstanceOf(AntigravityLoopbackResponseError)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('rejects a loopback response whose body is truncated', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-length': '100', 'content-type': 'application/json' })
      response.flushHeaders()
      response.write('{}')
      setImmediate(() => response.destroy())
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP listener')
    }

    try {
      await expect(
        fetchAntigravityQuotaEndpoint('http:', address.port, new AbortController().signal)
      ).rejects.toBeInstanceOf(AntigravityLoopbackResponseError)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
