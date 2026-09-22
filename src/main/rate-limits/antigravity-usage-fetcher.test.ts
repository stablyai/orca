import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_USAGE_PROBE_FAILED,
  ANTIGRAVITY_USAGE_UNAVAILABLE,
  fetchAntigravityRateLimits,
  mapAntigravityQuotaSummary,
  parseAntigravityLanguageServerLog
} from './antigravity-usage-fetcher'

const GROUPED_SUMMARY = {
  response: {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          {
            bucketId: 'gemini-weekly',
            displayName: 'Weekly Limit Remaining',
            remainingFraction: 0.8,
            resetTime: '2026-09-20T12:00:00Z'
          },
          {
            bucketId: 'gemini-5h',
            displayName: 'Five Hour Limit Remaining',
            remainingFraction: 0.4,
            resetTime: '2026-09-16T01:00:00Z'
          }
        ]
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          {
            bucketId: 'claude-gpt-weekly',
            displayName: 'Weekly Limit Remaining',
            remainingFraction: 0.95,
            resetTime: '2026-09-20T12:00:00Z'
          },
          {
            bucketId: 'claude-gpt-5h',
            displayName: 'Five Hour Limit Remaining',
            remainingFraction: 0.7,
            resetTime: '2026-09-16T01:00:00Z'
          }
        ]
      }
    ]
  }
}

const LIVE_LOG = [
  'Starting language server process with pid 4242',
  'listening on random port at 4312 for HTTP',
  'listening on random port at 4313 for HTTPS (gRPC)'
].join('\n')

const QUOTA_25_PERCENT_USED = {
  response: {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          {
            bucketId: 'gemini-5h',
            displayName: 'Five Hour Limit Remaining',
            remainingFraction: 0.75,
            resetTime: '2026-09-16T01:00:00Z'
          }
        ]
      }
    ]
  }
}

/** Above pid_max on every supported POSIX host, so kill(pid, 0) is a real ESRCH. */
const EXITED_SESSION_PID = 2_147_483_647

function languageServerLog(pid: number, httpPort: number): string {
  return [
    `Starting language server process with pid ${pid}`,
    `listening on random port at ${httpPort} for HTTP`
  ].join('\n')
}

describe('parseAntigravityLanguageServerLog', () => {
  it('reads pid and both loopback ports from an Agy startup banner', () => {
    expect(parseAntigravityLanguageServerLog(LIVE_LOG)).toEqual({
      pid: 4242,
      httpPort: 4312,
      httpsPort: 4313
    })
  })
})

describe('mapAntigravityQuotaSummary', () => {
  it('maps native grouped remainingFraction buckets onto session and weekly', () => {
    const limits = mapAntigravityQuotaSummary(GROUPED_SUMMARY)
    expect(limits?.provider).toBe('antigravity')
    expect(limits?.status).toBe('ok')
    expect(limits?.session?.usedPercent).toBe(60)
    expect(limits?.session?.windowMinutes).toBe(300)
    expect(limits?.weekly?.usedPercent).toBe(20)
    expect(limits?.weekly?.windowMinutes).toBe(10_080)
  })

  it('ignores disabled buckets', () => {
    const limits = mapAntigravityQuotaSummary({
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              {
                bucketId: 'gemini-5h',
                displayName: 'Five Hour Limit Remaining',
                remainingFraction: 0.1,
                disabled: true
              },
              {
                bucketId: 'gemini-weekly',
                displayName: 'Weekly Limit Remaining',
                remainingFraction: 0.5
              }
            ]
          }
        ]
      }
    })
    expect(limits?.session).toBeNull()
    expect(limits?.weekly?.usedPercent).toBe(50)
  })
})

describe('fetchAntigravityRateLimits', () => {
  const endpoint = {
    pid: 4242,
    httpPort: 4312,
    httpsPort: 4313
  }

  it('POSTs the quota RPC to the current live loopback endpoint and maps the summary', async () => {
    const posted: string[] = []
    const limits = await fetchAntigravityRateLimits({
      endpoint,
      postQuota: async (url) => {
        posted.push(url)
        expect(url.startsWith('http://127.0.0.1:')).toBe(true)
        return GROUPED_SUMMARY
      }
    })
    expect(posted).toEqual([
      'http://127.0.0.1:4312/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
    ])
    expect(limits.status).toBe('ok')
    expect(limits.session?.usedPercent).toBe(60)
  })

  it('reports unavailable when no local LanguageServer is running', async () => {
    const limits = await fetchAntigravityRateLimits({
      endpoint: null,
      postQuota: async () => {
        throw new Error('must not probe loopback when no LanguageServer is running')
      }
    })
    expect(limits.status).toBe('unavailable')
    expect(limits.provider).toBe('antigravity')
    expect(limits.error).toBe(ANTIGRAVITY_USAGE_UNAVAILABLE)
    expect(limits.usageMetadata?.failureKind).toBe('cli-unavailable')
    expect(limits.session).toBeNull()
    expect(limits.weekly).toBeNull()
  })

  it('reports a probe error when a LanguageServer is found but quota is not returned', async () => {
    const limits = await fetchAntigravityRateLimits({
      endpoint,
      postQuota: async () => null
    })
    expect(limits.status).toBe('error')
    expect(limits.error).toBe(ANTIGRAVITY_USAGE_PROBE_FAILED)
    expect(limits.usageMetadata?.failureKind).toBe('network')
    expect(limits.session).toBeNull()
  })

  it('falls back to the HTTPS loopback port when HTTP does not answer', async () => {
    const posted: string[] = []
    const limits = await fetchAntigravityRateLimits({
      endpoint,
      postQuota: async (url) => {
        posted.push(url)
        if (url.startsWith('http://')) {
          return null
        }
        return GROUPED_SUMMARY
      }
    })
    expect(posted).toEqual([
      'http://127.0.0.1:4312/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
      'https://127.0.0.1:4313/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
    ])
    expect(limits.status).toBe('ok')
  })
})

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP listen address')
  }
  return {
    port: address.port,
    close: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    }
  }
}

describe('Antigravity loopback quota request limits', () => {
  it('aborts an oversized quota response and reports a probe failure', async () => {
    const { port, close } = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('{"response":{"groups":[]}}'.padEnd(64, '0'))
    })
    try {
      const limits = await fetchAntigravityRateLimits({
        endpoint: { pid: 4242, httpPort: port, httpsPort: null },
        maxResponseBytes: 16
      })
      expect(limits.status).toBe('error')
      expect(limits.error).toBe(ANTIGRAVITY_USAGE_PROBE_FAILED)
    } finally {
      await close()
    }
  })

  it('aborts a continuously streaming quota response on the wall-clock deadline', async () => {
    const { port, close } = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      const timer = setInterval(() => {
        response.write(' ')
      }, 10)
      response.on('close', () => clearInterval(timer))
    })
    try {
      const started = Date.now()
      const limits = await fetchAntigravityRateLimits({
        endpoint: { pid: 4242, httpPort: port, httpsPort: null },
        requestTimeoutMs: 80
      })
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(limits.status).toBe('error')
      expect(limits.error).toBe(ANTIGRAVITY_USAGE_PROBE_FAILED)
    } finally {
      await close()
    }
  })
})

describe('Antigravity LanguageServer log discovery', () => {
  it('still finds an older live session after 12 newer exited session logs', async () => {
    expect(() => process.kill(EXITED_SESSION_PID, 0)).toThrow()
    const home = mkdtempSync(join(tmpdir(), 'orca-antigravity-usage-'))
    const logDir = join(home, '.gemini', 'antigravity-cli', 'log')
    mkdirSync(logDir, { recursive: true })
    let probeCount = 0
    const { port, close } = await listen((_request, response) => {
      probeCount += 1
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(QUOTA_25_PERCENT_USED))
    })
    try {
      writeFileSync(
        join(logDir, 'cli-2026-01-01T00-00-00.log'),
        languageServerLog(process.pid, port)
      )
      for (let index = 0; index < 12; index += 1) {
        writeFileSync(
          join(logDir, `cli-2026-09-19T00-00-${String(index).padStart(2, '0')}.log`),
          languageServerLog(EXITED_SESSION_PID, 65_000)
        )
      }
      const limits = await fetchAntigravityRateLimits({ homedir: () => home })
      expect(limits.status).toBe('ok')
      expect(limits.session?.usedPercent).toBe(25)
      expect(probeCount).toBe(1)
    } finally {
      await close()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
