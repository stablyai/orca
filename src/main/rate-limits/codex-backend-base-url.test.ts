import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }))

vi.mock('node:fs/promises', () => ({ readFile: readFileMock }))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))

import {
  buildCodexRateLimitResetCreditsUrl,
  normalizeCodexBackendBaseUrl,
  resolveCodexBackendBaseUrl
} from './codex-backend-base-url'
import { consumeCodexRateLimitResetCredit } from './codex-fetcher'

describe('Codex backend base URL', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('normalizes official ChatGPT hosts and keeps custom backend paths', () => {
    expect(normalizeCodexBackendBaseUrl(null)).toBe('https://chatgpt.com/backend-api')
    expect(normalizeCodexBackendBaseUrl('https://ChatGPT.com/')).toBe(
      'https://chatgpt.com/backend-api'
    )
    expect(normalizeCodexBackendBaseUrl('https://api.example.com/v1/')).toBe(
      'https://api.example.com/v1'
    )
    expect(buildCodexRateLimitResetCreditsUrl('https://api.example.com')).toBe(
      'https://api.example.com/api/codex/rate-limit-reset-credits'
    )
    expect(buildCodexRateLimitResetCreditsUrl('https://api.example.com/backend-api')).toBe(
      'https://api.example.com/backend-api/api/codex/rate-limit-reset-credits'
    )
  })

  it('reads only a top-level chatgpt_base_url from the selected Codex home', async () => {
    readFileMock.mockResolvedValue(
      [
        '"chatgpt_base_url" = \'https://api.example.com/v1\'',
        '',
        '[profile.work]',
        'chatgpt_base_url = "https://ignored.example.com"',
        ''
      ].join('\n')
    )

    await expect(resolveCodexBackendBaseUrl('/managed/codex-home')).resolves.toBe(
      'https://api.example.com/v1'
    )
    expect(readFileMock).toHaveBeenCalledWith('/managed/codex-home/config.toml', 'utf8')
  })

  it('reads a top-level chatgpt_base_url after a UTF-8 BOM', async () => {
    readFileMock.mockResolvedValue('\uFEFFchatgpt_base_url = "https://api.example.com/v2"\n')

    await expect(resolveCodexBackendBaseUrl('/managed/codex-home')).resolves.toBe(
      'https://api.example.com/v2'
    )
  })

  it('routes reset-credit consumption through the selected custom backend', async () => {
    readFileMock.mockImplementation(async (path: string) =>
      path.endsWith('config.toml')
        ? 'chatgpt_base_url = "https://api.example.com/v1"\n'
        : JSON.stringify({ tokens: { access_token: 'access-token' } })
    )
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ code: 'reset' })
    } as Response)

    await expect(
      consumeCodexRateLimitResetCredit({
        codexHomePath: '/managed/codex-home',
        idempotencyKey: 'redeem-1'
      })
    ).resolves.toBe('reset')

    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/v1/api/codex/rate-limit-reset-credits/consume',
      expect.anything()
    )
  })
})
