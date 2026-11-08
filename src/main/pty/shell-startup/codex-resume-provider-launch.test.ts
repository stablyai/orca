import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pinCodexResumeProviderLaunch } from './codex-resume-provider-launch'

const mocks = vi.hoisted(() => ({
  runProcess: vi.fn(),
  shell: vi.fn((): 'posix' | 'powershell' | 'cmd' => 'posix')
}))
vi.mock('@orca/process-host', () => ({ runProcess: mocks.runProcess }))
vi.mock('../../ipc/command-path/command-path-resolver', () => ({
  resolveCommandOnLocalPath: async () => '/bin/codex'
}))
vi.mock('../../../shared/windows-terminal-shell', () => ({
  resolveLocalWindowsAgentStartupShell: mocks.shell
}))

const sessionId = '019f81b9-19a9-7651-a8d1-352d9420bd11'
const base = {
  sessionId,
  modelProvider: 'openai',
  codexHomePath: '/saved/account',
  shellOverride: undefined,
  env: { OPENAI_BASE_URL: 'https://existing.example/v1' },
  cwd: '/project'
}

beforeEach(() => {
  mocks.runProcess.mockReset().mockResolvedValue({ stdout: 'Options: -c, --config <key=value>' })
  mocks.shell.mockReturnValue('posix')
})

describe('Codex resume provider invocation', () => {
  it.each(['openai', 'headroom', 'true', '123'])(
    'pins %s instead of inheriting the current default',
    async (modelProvider) => {
      await expect(
        pinCodexResumeProviderLaunch({
          ...base,
          modelProvider,
          command: `codex resume ${sessionId}`
        })
      ).resolves.toBe(`codex -c 'model_provider="${modelProvider}"' resume ${sessionId}`)
    }
  )

  it('overrides a conflicting requested provider only for this invocation', async () => {
    await expect(
      pinCodexResumeProviderLaunch({
        ...base,
        command: `codex -c model_provider=headroom resume ${sessionId}`
      })
    ).resolves.toBe(
      `codex -c model_provider=headroom -c 'model_provider="openai"' resume ${sessionId}`
    )
    expect(mocks.runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['resume', '--help'],
        env: expect.objectContaining({
          CODEX_HOME: '/saved/account',
          OPENAI_BASE_URL: 'https://existing.example/v1'
        })
      })
    )
  })

  it.each([
    ['posix', `codex -c 'model_provider="openai"' resume ${sessionId}`],
    ['powershell', `codex -c 'model_provider="openai"' resume ${sessionId}`],
    ['cmd', `codex -c model_provider='openai' resume ${sessionId}`]
  ] as const)('keeps one pin when a saved %s launch is restored', async (shell, command) => {
    mocks.shell.mockReturnValue(shell)
    await expect(pinCodexResumeProviderLaunch({ ...base, command })).resolves.toBe(command)
  })

  it.each(['posix', 'powershell', 'cmd'] as const)(
    'preserves the resume locator in %s',
    async (shell) => {
      mocks.shell.mockReturnValue(shell)
      const command =
        shell === 'powershell' ? `& 'codex' resume '${sessionId}'` : `codex resume "${sessionId}"`
      const expected =
        shell === 'powershell'
          ? `& 'codex' -c 'model_provider="openai"' resume '${sessionId}'`
          : shell === 'cmd'
            ? `codex -c model_provider='openai' resume "${sessionId}"`
            : `codex -c 'model_provider="openai"' resume "${sessionId}"`
      await expect(pinCodexResumeProviderLaunch({ ...base, command })).resolves.toBe(expected)
    }
  )

  it('refuses an older CLI without config overrides', async () => {
    mocks.runProcess.mockResolvedValue({ stdout: 'resume [SESSION_ID]' })
    await expect(
      pinCodexResumeProviderLaunch({ ...base, command: `codex resume ${sessionId}` })
    ).rejects.toThrow('cannot safely select')
  })

  it('refuses a timed out capability probe without replacing the session', async () => {
    mocks.runProcess.mockRejectedValue(new Error('timeout'))
    await expect(
      pinCodexResumeProviderLaunch({ ...base, command: `codex resume ${sessionId}` })
    ).rejects.toThrow('cannot safely select')
  })

  it.each([
    `codex --oss resume ${sessionId}`,
    `codex --remote ws://localhost:1234 resume ${sessionId}`,
    `codex resume other-session`,
    `wrapper codex resume ${sessionId}`,
    `codex; echo resume ${sessionId}`,
    `codex\necho resume ${sessionId}`,
    `codex -- resume ${sessionId}`
  ])('refuses an unverifiable launch %s', async (command) => {
    await expect(pinCodexResumeProviderLaunch({ ...base, command })).rejects.toThrow(
      'cannot safely select'
    )
  })
})
