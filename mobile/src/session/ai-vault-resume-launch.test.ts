import { describe, expect, it, vi } from 'vitest'
import { resumeAiVaultSessionInTerminal } from './ai-vault-resume-launch'
import { RESUME_RPC_TIMEOUT_MS } from './ai-vault-resume-preparation'
import { readMobileRuntimeHostPlatform } from '../transport/mobile-runtime-host-platform'

describe('resumeAiVaultSessionInTerminal', () => {
  it('creates a fresh terminal and sends the command with Enter', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        result: { tab: { type: 'terminal', id: 'tab-1', terminal: 'pty-1', title: 'Terminal' } }
      })
      .mockResolvedValueOnce({ ok: true, result: { send: { accepted: true } } })

    await expect(
      resumeAiVaultSessionInTerminal({ sendRequest }, 'worktree-1', {
        command: 'claude --resume abc',
        env: { ANTHROPIC_BASE_URL: 'http://localhost:3000' },
        envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'],
        launchConfig: {
          agentCommand: 'claude',
          agentArgs: '',
          agentEnv: { ANTHROPIC_BASE_URL: 'http://localhost:3000' }
        },
        launchAgent: 'claude',
        clientMutationId: 'resume-1',
        activate: false,
        select: true,
        navigation: 'caller'
      })
    ).resolves.toMatchObject({ id: 'tab-1', terminal: 'pty-1' })
    expect(sendRequest).toHaveBeenNthCalledWith(
      1,
      'session.tabs.createTerminal',
      {
        worktree: 'id:worktree-1',
        env: { ANTHROPIC_BASE_URL: 'http://localhost:3000' },
        envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'],
        launchConfig: {
          agentCommand: 'claude',
          agentArgs: '',
          agentEnv: { ANTHROPIC_BASE_URL: 'http://localhost:3000' }
        },
        launchAgent: 'claude',
        clientMutationId: 'resume-1',
        activate: false,
        select: true,
        navigation: 'caller'
      },
      // Why: a socket drop mid-resume must reject within the request timeout
      // instead of parking on the reconnect waiter with the spinner pinned.
      { timeoutMs: RESUME_RPC_TIMEOUT_MS }
    )
    expect(sendRequest).toHaveBeenNthCalledWith(
      2,
      'terminal.send',
      {
        terminal: 'pty-1',
        text: 'claude --resume abc',
        enter: true
      },
      { timeoutMs: RESUME_RPC_TIMEOUT_MS }
    )
  })

  it('throws when terminal creation fails', async () => {
    const sendRequest = vi.fn().mockResolvedValueOnce({
      ok: false,
      error: { message: 'no terminal' }
    })
    await expect(
      resumeAiVaultSessionInTerminal({ sendRequest }, 'worktree-1', { command: 'command' })
    ).rejects.toThrow('no terminal')
  })

  it('reauthorizes before sending the resume command', async () => {
    let current = true
    const sendRequest = vi.fn().mockImplementation(async () => {
      current = false
      return {
        ok: true,
        result: { tab: { type: 'terminal', id: 'tab-1', terminal: 'pty-1' } }
      }
    })

    await expect(
      resumeAiVaultSessionInTerminal({ sendRequest }, 'worktree-1', { command: 'command' }, () => {
        if (!current) {
          throw new Error('revoked')
        }
      })
    ).rejects.toThrow('revoked')
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('throws when the created terminal response is malformed', async () => {
    const sendRequest = vi.fn().mockResolvedValueOnce({ ok: true, result: { tab: { id: 'x' } } })
    await expect(
      resumeAiVaultSessionInTerminal({ sendRequest }, 'worktree-1', { command: 'command' })
    ).rejects.toThrow('Created terminal response was invalid')
  })

  it('throws when terminal send fails or is locked', async () => {
    const failedSend = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        result: { tab: { type: 'terminal', id: 'tab-1', terminal: 'pty-1' } }
      })
      .mockResolvedValueOnce({ ok: false, error: { message: 'send failed' } })
    await expect(
      resumeAiVaultSessionInTerminal({ sendRequest: failedSend }, 'worktree-1', {
        command: 'command'
      })
    ).rejects.toThrow('send failed')

    const lockedSend = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        result: { tab: { type: 'terminal', id: 'tab-1', terminal: 'pty-1' } }
      })
      .mockResolvedValueOnce({ ok: true, result: { send: { accepted: false } } })
    await expect(
      resumeAiVaultSessionInTerminal({ sendRequest: lockedSend }, 'worktree-1', {
        command: 'command'
      })
    ).rejects.toThrow('Terminal input is locked')
  })
})

describe('mobile runtime host platform', () => {
  it('reads a valid host platform from status.get', () => {
    expect(readMobileRuntimeHostPlatform({ hostPlatform: 'win32' })).toBe('win32')
    expect(readMobileRuntimeHostPlatform({ hostPlatform: 'not-a-platform' })).toBeNull()
  })
})
