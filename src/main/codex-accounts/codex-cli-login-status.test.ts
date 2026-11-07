import { describe, expect, it, vi } from 'vitest'
import { createCodexLoginStatusProbe, parseCodexLoginStatusText } from './codex-cli-login-status'
import { readTopLevelCredentialStoreValue } from './codex-credential-store-mode'

describe('parseCodexLoginStatusText', () => {
  it('maps the documented status outputs', () => {
    expect(parseCodexLoginStatusText('Not logged in\n', 1)).toEqual({
      authenticated: false,
      authKind: 'none'
    })
    expect(parseCodexLoginStatusText('Logged in using ChatGPT\n', 0)).toEqual({
      authenticated: true,
      authKind: 'oauth'
    })
    expect(parseCodexLoginStatusText('Logged in using access token\n', 0)).toEqual({
      authenticated: true,
      authKind: 'oauth'
    })
    expect(parseCodexLoginStatusText('Logged in using personal access token\n', 0)).toEqual({
      authenticated: true,
      authKind: 'oauth'
    })
    expect(
      parseCodexLoginStatusText('API key configured - sk-12345678\nAuthentication is checked…', 0)
    ).toEqual({ authenticated: true, authKind: 'api-key' })
    expect(parseCodexLoginStatusText('Logged in using workload identity\n', 0)).toEqual({
      authenticated: true,
      authKind: 'api-key'
    })
    expect(parseCodexLoginStatusText('Error checking login status: boom', 1)).toBeNull()
  })
})

describe('readTopLevelCredentialStoreValue', () => {
  it('reads quoted store modes only from the root table', () => {
    expect(readTopLevelCredentialStoreValue('cli_auth_credentials_store = "keyring"\n')).toBe(
      'keyring'
    )
    expect(readTopLevelCredentialStoreValue("cli_auth_credentials_store = 'auto'\n")).toBe('auto')
    expect(readTopLevelCredentialStoreValue('model = "gpt-5"\n')).toBeNull()
    expect(
      readTopLevelCredentialStoreValue('[profile.x]\ncli_auth_credentials_store = "keyring"\n')
    ).toBeNull()
  })
})

describe('createCodexLoginStatusProbe', () => {
  it('caches the probed status and shares concurrent refreshes', async () => {
    let resolveRun: ((result: { text: string; code: number | null }) => void) | null = null
    const run = vi.fn(
      () =>
        new Promise<{ text: string; code: number | null }>((resolve) => {
          resolveRun = resolve
        })
    )
    const probe = createCodexLoginStatusProbe(() => '/home/codex', run)

    const first = probe.refresh()
    const second = probe.refresh()
    expect(run).toHaveBeenCalledTimes(1)
    resolveRun!({ text: 'Logged in using ChatGPT', code: 0 })
    expect(await first).toEqual({ authenticated: true, authKind: 'oauth' })
    expect(await second).toEqual({ authenticated: true, authKind: 'oauth' })
    expect(probe.read()).toEqual({ authenticated: true, authKind: 'oauth' })
  })

  it('keeps the last known status when a probe fails', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ text: 'Logged in using ChatGPT', code: 0 })
      .mockRejectedValueOnce(new Error('spawn failed'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const probe = createCodexLoginStatusProbe(() => '/home/codex', run)

    try {
      expect(await probe.refresh()).toEqual({ authenticated: true, authKind: 'oauth' })
      expect(await probe.refresh()).toEqual({ authenticated: true, authKind: 'oauth' })
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('throttles refreshIfStale after a probe that produced no status', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('spawn failed'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const probe = createCodexLoginStatusProbe(() => '/home/codex', run)

    try {
      expect(await probe.refresh()).toBeNull()
      probe.refreshIfStale()
      expect(run).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})
