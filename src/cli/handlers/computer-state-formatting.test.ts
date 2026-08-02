import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../runtime-client', () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }

  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  class RuntimeRpcFailureError extends RuntimeClientError {
    readonly response: unknown

    constructor(response: unknown) {
      super('runtime_error', 'runtime_error')
      this.response = response
    }
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError
  }
})

import { main } from '../index'
import { okFixture, queueFixtures } from '../test-fixtures'

describe('orca computer get-app-state formatting', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = undefined
  })

  it('formats get-app-state without printing screenshot bytes in pretty mode', async () => {
    queueFixtures(callMock, okFixture('req_state', sampleSnapshot()))

    await main(['computer', 'get-app-state', '--session', 'manual', '--app', 'Finder'], '/tmp/repo')

    const output = vi.mocked(console.log).mock.calls[0][0]
    expect(output).toContain('Finder (pid 100, com.apple.finder)')
    expect(output).toContain('App=com.apple.finder')
    expect(output).not.toContain('base64-data')
  })

  it('omits screenshot bytes from JSON output and writes a screenshot path', async () => {
    queueFixtures(callMock, okFixture('req_state', sampleSnapshot()))

    await main(
      ['computer', 'get-app-state', '--session', 'manual', '--app', 'Finder', '--json'],
      '/tmp/repo'
    )

    const output = vi.mocked(console.log).mock.calls[0][0]
    expect(output).not.toContain('base64-data')
    const parsed = JSON.parse(output)
    expect(parsed.result.screenshot).toMatchObject({
      dataOmitted: true,
      format: 'png',
      expiresAt: expect.any(String)
    })
    expect(String(parsed.result.screenshot.path).replaceAll('\\', '/')).toContain(
      'orca-computer-use/req_state-screenshot.png'
    )
  })

  it('shows coordinate space and truncation in pretty state output', async () => {
    queueFixtures(callMock, okFixture('req_state', sampleSnapshot()))

    await main(['computer', 'get-app-state', '--session', 'manual', '--app', 'Finder'], '/tmp/repo')

    const output = vi.mocked(console.log).mock.calls[0][0]
    expect(output).toContain('Coordinates: window')
    expect(output).toContain('Truncated: no')
  })
})

function sampleSnapshot() {
  return {
    snapshot: {
      id: 'snap-test',
      app: { name: 'Finder', bundleId: 'com.apple.finder', pid: 100 },
      window: { title: 'Finder', width: 800, height: 600 },
      coordinateSpace: 'window',
      truncation: { truncated: false, maxNodes: 1200, maxDepth: 64, maxDepthReached: false },
      treeText: 'App=com.apple.finder (pid 100)\n0 standard window Finder',
      elementCount: 1,
      focusedElementId: 0
    },
    screenshot: {
      data: 'base64-data',
      format: 'png',
      width: 800,
      height: 600,
      scale: 1
    },
    screenshotStatus: { state: 'captured' }
  }
}
