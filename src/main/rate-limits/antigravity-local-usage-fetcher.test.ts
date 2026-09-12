import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchAntigravityLocalRateLimits,
  resetCachedAntigravityEndpointForTests
} from './antigravity-local-usage-fetcher'
import {
  parseLsofListeningPorts,
  parseNetstatListeningPorts
} from './antigravity-local-endpoint-discovery'
import http from 'node:http'

const { runProcessMock, readWindowsProcessTableMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  readWindowsProcessTableMock: vi.fn()
}))

vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: runProcessMock
}))

vi.mock('../windows/windows-process-table', () => ({
  readWindowsProcessTable: readWindowsProcessTableMock
}))

describe('antigravity-local-usage-fetcher', () => {
  beforeEach(() => {
    resetCachedAntigravityEndpointForTests()
    runProcessMock.mockReset()
    readWindowsProcessTableMock.mockReset()
  })

  describe('port parsers', () => {
    it('parses netstat listening ports matching target PIDs', () => {
      const netstatOutput = `
  TCP    127.0.0.1:60232        0.0.0.0:0              LISTENING       13052
  TCP    127.0.0.1:60233        0.0.0.0:0              LISTENING       13052
  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       99999
  TCP    [::1]:50821            [::]:0                 LISTENING       13052
`
      const ports = parseNetstatListeningPorts(netstatOutput, new Set([13052]))
      expect(ports).toEqual([
        { port: 60232, pid: 13052 },
        { port: 60233, pid: 13052 },
        { port: 50821, pid: 13052 }
      ])
    })

    it('parses lsof listening output matching target PIDs', () => {
      const lsofOutput = `
p13052
cagy
n127.0.0.1:60232
n127.0.0.1:60233
p99999
cother
n127.0.0.1:8080
`
      const ports = parseLsofListeningPorts(lsofOutput, new Set([13052]))
      expect(ports).toEqual([
        { port: 60232, pid: 13052 },
        { port: 60233, pid: 13052 }
      ])
    })
  })

  describe('fetchAntigravityLocalRateLimits', () => {
    let mockServer: http.Server
    let serverPort: number

    beforeEach(async () => {
      await new Promise<void>((resolve) => {
        mockServer = http.createServer((req, res) => {
          if (req.url?.includes('RetrieveUserQuotaSummary')) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                response: {
                  groups: [
                    {
                      displayName: 'Gemini Models',
                      buckets: [
                        {
                          bucketId: 'gemini-5h',
                          displayName: '5h',
                          window: '5h',
                          remainingFraction: 0.85,
                          resetTime: '2026-09-02T13:00:00Z'
                        },
                        {
                          bucketId: 'gemini-weekly',
                          displayName: 'Weekly',
                          window: 'weekly',
                          remainingFraction: 0.9,
                          resetTime: '2026-09-08T18:00:00Z'
                        }
                      ]
                    },
                    {
                      displayName: 'Claude and GPT models',
                      buckets: [
                        {
                          bucketId: '3p-5h',
                          displayName: 'Claude 5h',
                          window: '5h',
                          remainingFraction: 1,
                          resetTime: '2026-09-02T13:00:00Z'
                        }
                      ]
                    }
                  ]
                }
              })
            )
          } else if (req.url?.includes('GetUserStatus')) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                userStatus: {
                  name: 'Test User',
                  email: 'test@example.com',
                  planStatus: {
                    planInfo: {
                      planName: 'Pro'
                    }
                  }
                }
              })
            )
          } else {
            res.writeHead(404)
            res.end()
          }
        })
        mockServer.listen(0, '127.0.0.1', () => {
          const addr = mockServer.address()
          serverPort = typeof addr === 'object' && addr ? addr.port : 0
          resolve()
        })
      })
    })

    it('successfully queries local language server and parses quotas', async () => {
      readWindowsProcessTableMock.mockResolvedValue([
        {
          pid: 1234,
          name: 'agy.exe',
          command: `agy.exe --server_port=${serverPort}`
        }
      ])
      runProcessMock.mockImplementation(async ({ program }) => {
        if (program === 'ps') {
          return {
            code: 0,
            stdout: `1234 /usr/local/bin/agy --server_port=${serverPort}\n`,
            stderr: '',
            signal: null,
            timedOut: false
          }
        }
        return {
          code: 1,
          stdout: '',
          stderr: '',
          signal: null,
          timedOut: false
        }
      })

      const result = await fetchAntigravityLocalRateLimits()
      expect(result).not.toBeNull()
      expect(result?.status).toBe('ok')
      expect(result?.provider).toBe('gemini')
      expect(result?.planType).toBe('Pro')
      expect(result?.session?.usedPercent).toBe(15)
      expect(result?.session?.windowMinutes).toBe(300)
      expect(result?.weekly?.usedPercent).toBe(10)
      expect(result?.weekly?.windowMinutes).toBe(10080)
      expect(result?.buckets).toBeUndefined()

      mockServer.close()
    })

    it('returns null when no candidate process is running', async () => {
      readWindowsProcessTableMock.mockResolvedValue([])
      runProcessMock.mockResolvedValue({
        code: 1,
        stdout: '',
        stderr: '',
        signal: null,
        timedOut: false
      })

      const result = await fetchAntigravityLocalRateLimits()
      expect(result).toBeNull()

      mockServer.close()
    })
  })
})
