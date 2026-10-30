import { describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import {
  buildMobileAiVaultResumeLaunch,
  createMobileAiVaultResumeMutationRegistry,
  readMobileAiVaultResumeHost,
  readMobileRuntimeTerminalWindowsShell,
  resolveMobileAiVaultResumePlatform,
  resumeAiVaultSessionInTerminal
} from './ai-vault-resume-launch'
import { readMobileRuntimeHostPlatform } from '../transport/mobile-runtime-host-platform'
import { RESUME_RPC_TIMEOUT_MS } from './ai-vault-resume-preparation'

function session(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'claude:1',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'session 1',
    title: 'Resume me',
    cwd: '/Users/ada/repo',
    branch: 'main',
    model: null,
    filePath: '/Users/ada/.claude/session.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-06-29T00:00:00.000Z',
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

describe('buildMobileAiVaultResumeLaunch', () => {
  it('resumes Cursor by conversation id with its default args and launch config like desktop', () => {
    const launch = buildMobileAiVaultResumeLaunch({
      session: session({ agent: 'cursor', sessionId: 'cursor-1' }),
      workspacePlatform: 'darwin',
      settings: { agentDefaultArgs: { cursor: '--model gpt-5' } }
    })

    expect(launch).toMatchObject({
      launchConfig: { agentArgs: '--model gpt-5' },
      launchAgent: 'cursor',
      resumeProviderSession: { key: 'conversation_id', id: 'cursor-1' }
    })
    expect(launch.command).toContain("'--model' 'gpt-5'")
  })

  it('deletes inherited Codex homes when resuming a real-home session like desktop', () => {
    // Strip inherited/default CODEX_HOME when resuming a real-home Codex session.
    const launch = buildMobileAiVaultResumeLaunch({
      session: session({ agent: 'codex', sessionId: 'codex-1', codexHome: null }),
      workspacePlatform: 'darwin',
      settings: {
        agentDefaultEnv: { codex: { CODEX_HOME: '/Users/ada/.codex-pinned' } }
      }
    })
    expect(launch.command).not.toContain('CODEX_HOME=')
    expect(launch.envToDelete).toEqual(['CODEX_HOME', 'ORCA_CODEX_HOME'])
  })
})

describe('resumeAiVaultSessionInTerminal', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'lets the %s execution host select the Qoder resume command at creation',
    async (hostPlatform) => {
      const launch = buildMobileAiVaultResumeLaunch({
        session: session({ agent: 'qoder', sessionId: 'same-qoder-session' }),
        workspacePlatform: hostPlatform
      })
      const sendRequest = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          result: { tab: { type: 'terminal', id: 'tab-1', terminal: 'pty-1', title: 'Terminal' } }
        })
        .mockResolvedValueOnce({ ok: true, result: { send: { accepted: true } } })
      await resumeAiVaultSessionInTerminal({ sendRequest }, 'worktree-1', {
        ...launch,
        clientMutationId: 'qoder-resume',
        hostCapabilities: ['session.tabs.qoderOwnedCreate.v1']
      })
      expect(sendRequest).toHaveBeenCalledTimes(1)
      expect(sendRequest).toHaveBeenCalledWith(
        'session.tabs.createTerminal',
        expect.objectContaining({
          command: launch.command,
          launchAgent: 'qoder',
          launchConfig: launch.launchConfig
        }),
        { timeoutMs: RESUME_RPC_TIMEOUT_MS }
      )
      expect(launch.command).toContain('same-qoder-session')
    }
  )

  it.each(
    [undefined, [], ['aiVault.v1']].flatMap((hostCapabilities) =>
      (['darwin', 'linux', 'win32'] as const).map((hostPlatform) => ({
        hostCapabilities,
        hostPlatform
      }))
    )
  )(
    'keeps the acknowledged-create fallback on an older $hostPlatform host',
    async ({ hostCapabilities, hostPlatform }) => {
      const launch = buildMobileAiVaultResumeLaunch({
        session: session({ agent: 'qoder', sessionId: 'legacy-session' }),
        workspacePlatform: hostPlatform
      })
      const sendRequest = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          result: { tab: { type: 'terminal', id: 'tab-1', terminal: 'pty-1', title: 'Terminal' } }
        })
        .mockResolvedValueOnce({ ok: true, result: { send: { accepted: true } } })
      await resumeAiVaultSessionInTerminal({ sendRequest }, 'worktree-1', {
        ...launch,
        hostCapabilities,
        clientMutationId: 'same-legacy-resume'
      })
      expect(sendRequest).toHaveBeenCalledTimes(2)
      expect(sendRequest.mock.calls[0]?.[1]).not.toHaveProperty('command')
      expect(sendRequest.mock.calls[1]).toEqual([
        'terminal.send',
        { terminal: 'pty-1', text: launch.command, enter: true },
        { timeoutMs: RESUME_RPC_TIMEOUT_MS }
      ])
    }
  )

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
        clientMutationId: 'resume-1'
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

  it('tells the host which conversation the created pane resumes', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        result: { tab: { type: 'terminal', id: 'tab-1', terminal: 'pty-1', title: 'Terminal' } }
      })
      .mockResolvedValueOnce({ ok: true, result: { send: { accepted: true } } })
    const launch = buildMobileAiVaultResumeLaunch({
      session: session({ agent: 'codex', sessionId: 'codex-1' }),
      workspacePlatform: 'darwin'
    })

    await resumeAiVaultSessionInTerminal({ sendRequest }, 'worktree-1', launch)

    expect(sendRequest).toHaveBeenNthCalledWith(
      1,
      'session.tabs.createTerminal',
      expect.objectContaining({
        launchAgent: 'codex',
        resumeProviderSession: { key: 'session_id', id: 'codex-1' }
      }),
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

  it('throws when the created terminal response is malformed', async () => {
    const sendRequest = vi.fn().mockResolvedValueOnce({ ok: true, result: { tab: { id: 'x' } } })
    await expect(
      resumeAiVaultSessionInTerminal({ sendRequest }, 'worktree-1', { command: 'command' })
    ).rejects.toThrow('The host sent a reply this app could not read (session.tabs.createTerminal)')
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

describe('createMobileAiVaultResumeMutationRegistry', () => {
  it('reuses the claimed id across retries until a success releases it', () => {
    let mints = 0
    const registry = createMobileAiVaultResumeMutationRegistry((sessionId) => {
      mints += 1
      return `${sessionId}:mutation-${mints}`
    })

    expect(registry.claim('session-a')).toBe('session-a:mutation-1')
    expect(registry.claim('session-a')).toBe('session-a:mutation-1')

    registry.releaseOnSuccess('session-a')
    expect(registry.claim('session-a')).toBe('session-a:mutation-2')
  })

  it('tracks sessions independently', () => {
    const registry = createMobileAiVaultResumeMutationRegistry((sessionId) => `${sessionId}:id`)
    expect(registry.claim('session-a')).toBe('session-a:id')
    expect(registry.claim('session-b')).toBe('session-b:id')
    registry.releaseOnSuccess('session-b')
    expect(registry.claim('session-a')).toBe('session-a:id')
  })
})

describe('resume platform helpers', () => {
  it('reads a valid host platform from status.get', () => {
    expect(readMobileRuntimeHostPlatform({ hostPlatform: 'win32' })).toBe('win32')
    expect(readMobileRuntimeHostPlatform({ hostPlatform: 'not-a-platform' })).toBeNull()
  })

  it('reads the host Windows terminal shell from status.get', () => {
    expect(readMobileRuntimeTerminalWindowsShell({ terminalWindowsShell: 'wsl.exe' })).toBe(
      'wsl.exe'
    )
    expect(readMobileRuntimeTerminalWindowsShell({ terminalWindowsShell: '' })).toBeNull()
  })

  it('uses Linux/POSIX construction for SSH targets and host platform for local targets', () => {
    expect(resolveMobileAiVaultResumePlatform('ssh', 'win32')).toBe('linux')
    expect(resolveMobileAiVaultResumePlatform('local', 'darwin')).toBe('darwin')
    expect(
      resolveMobileAiVaultResumePlatform(
        'local',
        'win32',
        '\\\\wsl.localhost\\Ubuntu\\home\\ada\\repo'
      )
    ).toBe('linux')
    expect(resolveMobileAiVaultResumePlatform('local', 'win32', 'C:\\repo', 'linux')).toBe('linux')
    expect(resolveMobileAiVaultResumePlatform('runtime', 'linux')).toBeNull()
  })
})

it.each([null, {}, { capabilities: 'session.tabs.qoderOwnedCreate.v1' }, { capabilities: [1] }])(
  'does not infer safe Qoder creation from unreadable host capabilities',
  (status) => {
    expect(readMobileAiVaultResumeHost(status).capabilities).toBeUndefined()
  }
)

it('reads the execution platform and advertised safe-create capability together', () => {
  expect(
    readMobileAiVaultResumeHost({
      hostPlatform: 'win32',
      capabilities: ['session.tabs.qoderOwnedCreate.v1']
    })
  ).toEqual({ platform: 'win32', capabilities: ['session.tabs.qoderOwnedCreate.v1'] })
})
