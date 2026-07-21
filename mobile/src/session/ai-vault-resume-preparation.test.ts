import { describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import {
  buildMobileAiVaultResumeLaunch,
  prepareMobileAiVaultSessionResume,
  resumeAiVaultSessionInTerminal,
  RESUME_RPC_TIMEOUT_MS
} from './ai-vault-resume-launch'

const LEGACY_CODEX_HOME = '/Users/ada/Library/Application Support/orca/codex-runtime-home/home'

function legacySession(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'codex:legacy-1',
    executionHostId: 'local',
    agent: 'codex',
    sessionId: 'legacy-1',
    title: 'Resume me',
    cwd: '/Users/ada/repo',
    branch: 'main',
    model: null,
    filePath: `${LEGACY_CODEX_HOME}/sessions/2026/07/20/rollout-a.jsonl`,
    codexHome: LEGACY_CODEX_HOME,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-07-20T00:00:00.000Z',
    messageCount: 2,
    totalTokens: 10,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null,
    ...overrides
  }
}

describe('prepareMobileAiVaultSessionResume', () => {
  it.each([
    {
      code: 'forbidden',
      message: "Method 'aiVault.prepareSessionResume' is not available to mobile clients"
    },
    {
      code: 'method_not_found',
      message: 'Unknown method: aiVault.prepareSessionResume'
    }
  ])('uses the legacy command and environment on old-host $code', async (error) => {
    const legacy = legacySession()
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error })
      .mockResolvedValueOnce({
        ok: true,
        result: { tab: { type: 'terminal', id: 'tab-1', terminal: 'pty-1', title: 'Terminal' } }
      })
      .mockResolvedValueOnce({ ok: true, result: { send: { accepted: true } } })

    const prepared = await prepareMobileAiVaultSessionResume({ sendRequest }, legacy)
    const launch = buildMobileAiVaultResumeLaunch({ session: prepared, hostPlatform: 'darwin' })
    await resumeAiVaultSessionInTerminal({ sendRequest }, 'worktree-1', launch)

    expect(prepared).toBe(legacy)
    expect(sendRequest.mock.calls[1]?.[1]).not.toHaveProperty('envToDelete')
    expect(sendRequest).toHaveBeenNthCalledWith(
      3,
      'terminal.send',
      {
        terminal: 'pty-1',
        text: `cd '/Users/ada/repo' && CODEX_HOME='${LEGACY_CODEX_HOME}' codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'legacy-1'`,
        enter: true
      },
      { timeoutMs: RESUME_RPC_TIMEOUT_MS }
    )
  })

  it('uses the real Codex home when a supported desktop requests it', async () => {
    const legacy = legacySession()
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: { useRealCodexHome: true }
    })

    const prepared = await prepareMobileAiVaultSessionResume({ sendRequest }, legacy)
    const launch = buildMobileAiVaultResumeLaunch({ session: prepared, hostPlatform: 'darwin' })

    expect(sendRequest).toHaveBeenCalledWith(
      'aiVault.prepareSessionResume',
      {
        agent: 'codex',
        filePath: legacy.filePath,
        codexHome: LEGACY_CODEX_HOME,
        executionHostId: 'local'
      },
      { timeoutMs: RESUME_RPC_TIMEOUT_MS }
    )
    expect(prepared).toEqual({ ...legacy, codexHome: null })
    expect(launch.command).toBe(
      "cd '/Users/ada/repo' && codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'legacy-1'"
    )
    expect(launch.envToDelete).toEqual(['CODEX_HOME', 'ORCA_CODEX_HOME'])
  })

  it('preserves the legacy resume path when a supported desktop declines real-home use', async () => {
    const legacy = legacySession()
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: { useRealCodexHome: false }
    })

    const prepared = await prepareMobileAiVaultSessionResume({ sendRequest }, legacy)
    const launch = buildMobileAiVaultResumeLaunch({ session: prepared, hostPlatform: 'darwin' })

    expect(prepared).toBe(legacy)
    expect(launch.command).toContain(`CODEX_HOME='${LEGACY_CODEX_HOME}'`)
    expect(launch.envToDelete).toBeUndefined()
  })

  it.each([
    { agent: 'claude' as const, codexHome: null },
    { agent: 'codex' as const, codexHome: '/Users/ada/.config/codex' },
    {
      agent: 'codex' as const,
      codexHome: '/Users/ada/Library/Application Support/orca/codex-accounts/a/home'
    },
    { agent: 'codex' as const, codexHome: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex' }
  ])('does not prepare non-legacy session $agent at $codexHome', async (overrides) => {
    const current = legacySession(overrides)
    const sendRequest = vi.fn()

    await expect(prepareMobileAiVaultSessionResume({ sendRequest }, current)).resolves.toBe(current)
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it.each([
    {
      code: 'internal_error',
      message: 'Retry resume after checking session folder permissions.'
    },
    {
      code: 'forbidden',
      message: 'Session resume is forbidden'
    }
  ])('keeps genuine server error visible: $code', async (error) => {
    const sendRequest = vi.fn().mockResolvedValue({ ok: false, error })

    await expect(
      prepareMobileAiVaultSessionResume({ sendRequest }, legacySession())
    ).rejects.toThrow(error.message)
  })

  it.each(['Request timed out: aiVault.prepareSessionResume', 'Connection interrupted'])(
    'keeps transport failure visible: %s',
    async (message) => {
      const failure = new Error(message)
      const sendRequest = vi.fn().mockRejectedValue(failure)

      await expect(
        prepareMobileAiVaultSessionResume({ sendRequest }, legacySession())
      ).rejects.toBe(failure)
    }
  )
})
