import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())
const files = vi.hoisted<{
  credentials: string | null
  cliVersion: string | null
  readError: Error | null
}>(() => ({ credentials: null, cliVersion: null, readError: null }))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

vi.mock('node:fs', () => ({
  existsSync: (path: string) => {
    if (path.endsWith('credentials.toml')) {
      return files.credentials !== null
    }
    if (path.endsWith('cached_version.json')) {
      return files.cliVersion !== null
    }
    return false
  },
  readFileSync: (path: string) => {
    if (files.readError) {
      throw files.readError
    }
    if (path.endsWith('credentials.toml')) {
      if (files.credentials === null) {
        throw new Error('ENOENT')
      }
      return files.credentials
    }
    if (path.endsWith('cached_version.json')) {
      if (files.cliVersion === null) {
        throw new Error('ENOENT')
      }
      return files.cliVersion
    }
    throw new Error('ENOENT')
  }
}))

vi.mock('node:os', () => ({ homedir: () => '/home/test' }))

import { fetchDevinRateLimits } from './devin-fetcher'

function protoResponse(body: Uint8Array, status = 200): Response {
  return new Response(Buffer.from(body), { status })
}

function encVarint(value: number): Uint8Array {
  const bytes: number[] = []
  let v = value >>> 0
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  bytes.push(v)
  return Uint8Array.from(bytes)
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function varField(num: number, value: number): Uint8Array {
  return concatBytes([encVarint(num << 3), encVarint(value)])
}

function strField(num: number, value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value)
  return concatBytes([encVarint((num << 3) | 2), encVarint(bytes.length), bytes])
}

function msgField(num: number, message: Uint8Array): Uint8Array {
  return concatBytes([encVarint((num << 3) | 2), encVarint(message.length), message])
}

// Mirrors GetUserStatusResponse{user_status{email=7, plan_status=13{
// plan_info=1{plan_name=2}, daily=14, weekly=15, resets=17/18}}}.
function userStatusResponse(planStatus: Uint8Array, email = 'dev@example.com'): Uint8Array {
  const userStatus = concatBytes([strField(7, email), msgField(13, planStatus)])
  return msgField(1, userStatus)
}

function quotaPlanStatus(
  overrides: { daily?: number; weekly?: number; dailyReset?: number; weeklyReset?: number } = {}
): Uint8Array {
  const planInfo = strField(2, 'Pro')
  return concatBytes([
    msgField(1, planInfo),
    varField(14, overrides.daily ?? 98),
    varField(15, overrides.weekly ?? 47),
    varField(17, overrides.dailyReset ?? 1_900_000_000),
    varField(18, overrides.weeklyReset ?? 1_900_500_000)
  ])
}

function credentialsToml(extra = ''): string {
  return `windsurf_api_key = "devin-session-token$test-token"\napi_server_url = "https://server.codeium.com"\n${extra}`
}

describe('fetchDevinRateLimits', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
    files.credentials = null
    files.cliVersion = null
    files.readError = null
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns unavailable when credentials.toml is missing', async () => {
    const result = await fetchDevinRateLimits()
    expect(result.provider).toBe('devin')
    expect(result.status).toBe('unavailable')
    expect(result.error).toMatch(/devin login/i)
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('returns unavailable when credentials.toml has no session token', async () => {
    files.credentials = 'api_server_url = "https://server.codeium.com"\n'
    const result = await fetchDevinRateLimits()
    expect(result.status).toBe('unavailable')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('returns error when the credentials file cannot be read', async () => {
    files.credentials = credentialsToml()
    files.readError = new Error('EACCES')
    const result = await fetchDevinRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toBe('Unable to read Devin credentials file')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('maps daily and weekly quota windows from the user status response', async () => {
    files.credentials = credentialsToml()
    netFetchMock.mockResolvedValueOnce(protoResponse(userStatusResponse(quotaPlanStatus())))

    const result = await fetchDevinRateLimits()
    expect(result.status).toBe('ok')
    expect(result.error).toBeNull()
    expect(result.session?.usedPercent).toBe(2)
    expect(result.session?.windowMinutes).toBe(1440)
    expect(result.session?.resetsAt).toBe(1_900_000_000_000)
    expect(result.weekly?.usedPercent).toBe(53)
    expect(result.weekly?.windowMinutes).toBe(10_080)
    expect(result.weekly?.resetsAt).toBe(1_900_500_000_000)
    expect(result.planType).toBe('Pro')
    expect(result.usageMetadata).toEqual({
      source: 'oauth',
      authProvenance: 'dev@example.com',
      credentialSource: 'credentials.toml'
    })
  })

  it('posts the CLI identity tuple to the seat management endpoint', async () => {
    files.credentials = credentialsToml()
    files.cliVersion = JSON.stringify({ latest: '3000.10.99' })
    netFetchMock.mockResolvedValueOnce(protoResponse(userStatusResponse(quotaPlanStatus())))

    await fetchDevinRateLimits()
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/proto',
          'Connect-Protocol-Version': '1'
        })
      })
    )
    const body: Buffer = netFetchMock.mock.calls[0][1].body
    expect(body.includes('devin-session-token$test-token')).toBe(true)
    expect(body.includes('devin-cli')).toBe(true)
    expect(body.includes('chisel')).toBe(true)
    expect(body.includes('3000.10.99')).toBe(true)
  })

  it('falls back to the released CLI identity version when none is installed', async () => {
    files.credentials = credentialsToml()
    netFetchMock.mockResolvedValueOnce(protoResponse(userStatusResponse(quotaPlanStatus())))

    await fetchDevinRateLimits()
    const body: Buffer = netFetchMock.mock.calls[0][1].body
    expect(body.includes('3000.6.2')).toBe(true)
  })

  it('normalizes a session token missing the devin-session-token prefix', async () => {
    files.credentials = 'windsurf_api_key = "raw-token"\n'
    netFetchMock.mockResolvedValueOnce(protoResponse(userStatusResponse(quotaPlanStatus())))

    await fetchDevinRateLimits()
    const body: Buffer = netFetchMock.mock.calls[0][1].body
    expect(body.includes('devin-session-token$raw-token')).toBe(true)
  })

  it('uses the configured api_server_url', async () => {
    files.credentials =
      'windsurf_api_key = "devin-session-token$test-token"\napi_server_url = "https://devin.example.com/"\n'
    netFetchMock.mockResolvedValueOnce(protoResponse(userStatusResponse(quotaPlanStatus())))

    await fetchDevinRateLimits()
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://devin.example.com/exa.seat_management_pb.SeatManagementService/GetUserStatus',
      expect.anything()
    )
  })

  it.each([401, 403])(
    'reports an expired session as delegated refresh on HTTP %i',
    async (status) => {
      files.credentials = credentialsToml()
      netFetchMock.mockResolvedValueOnce(protoResponse(new Uint8Array(), status))

      const result = await fetchDevinRateLimits()
      expect(result.status).toBe('error')
      expect(result.error).toMatch(/run devin on the computer running Orca/i)
      expect(result.usageMetadata).toEqual({
        failureKind: 'delegated-refresh-required',
        source: 'oauth'
      })
    }
  )

  it('surfaces other HTTP failures as errors', async () => {
    files.credentials = credentialsToml()
    netFetchMock.mockResolvedValueOnce(protoResponse(new Uint8Array(), 500))

    const result = await fetchDevinRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toBe('Devin usage request failed (HTTP 500)')
  })

  it('returns error for an undecodable response', async () => {
    files.credentials = credentialsToml()
    netFetchMock.mockResolvedValueOnce(protoResponse(Uint8Array.from([0xff, 0xff, 0xff])))

    const result = await fetchDevinRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toBe('Devin usage response was not a valid user status')
  })

  it('reports plans without quota windows as unavailable', async () => {
    files.credentials = credentialsToml()
    // plan_status present but no dated quota fields — credit-billed plans omit them.
    netFetchMock.mockResolvedValueOnce(
      protoResponse(userStatusResponse(msgField(1, strField(2, 'Teams'))))
    )

    const result = await fetchDevinRateLimits()
    expect(result.status).toBe('unavailable')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
    expect(result.error).toMatch(/did not report quota windows/i)
  })

  it('propagates fetch failures as errors', async () => {
    files.credentials = credentialsToml()
    netFetchMock.mockRejectedValueOnce(new Error('network down'))

    const result = await fetchDevinRateLimits()
    expect(result.status).toBe('error')
    expect(result.error).toBe('network down')
  })

  it('aborts the status request when the caller aborts', async () => {
    files.credentials = credentialsToml()
    const controller = new AbortController()
    let requestSignal: AbortSignal | undefined
    netFetchMock.mockImplementationOnce((_url, init: RequestInit) => {
      requestSignal = init.signal ?? undefined
      return new Promise((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true
        })
      })
    })

    const resultPromise = fetchDevinRateLimits({ signal: controller.signal })
    await Promise.resolve()

    expect(requestSignal?.aborted).toBe(false)
    controller.abort()
    expect(requestSignal?.aborted).toBe(true)

    const result = await resultPromise
    expect(result.status).toBe('error')
    expect(result.error).toBe('aborted')
  })
})
