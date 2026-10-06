import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertClaudeProfileCli,
  pinClaudeProfileTerminalCommand,
  supportsClaudeProfileKeychain
} from './claude-profile-cli'
import {
  assertClaudeProfileEnvironment,
  stripClaudeProfileProviderEnvironment
} from './claude-profile-environment'
import { buildClaudeChildProcessEnv } from '../claude/claude-child-process-environment'

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))

describe('Claude profile credential routing', () => {
  afterEach(() => vi.restoreAllMocks())
  it('uses a bounded shared process probe and rejects truncated output', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const { runProcess } = await import('../../shared/child-process/run-process')
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '2.1.0',
      stderr: '',
      timedOut: false,
      outputTruncated: true
    })
    await expect(assertClaudeProfileCli('/synthetic/cli')).rejects.toThrow()
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/synthetic/cli',
        args: ['--version'],
        timeoutMs: 5000,
        maxOutputBytes: 8192
      })
    )
  })
  it.each(['CLAUDE_CONFIG_DIR=/other claude', 'env claude', 'claude; echo unsafe'])(
    'refuses shell routing overrides on Linux: %s',
    async (command) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
      await expect(pinClaudeProfileTerminalCommand(command)).rejects.toThrow('direct Claude')
    }
  )
  it.each(['\r', '\n', '\0'])(
    'refuses raw control characters before a CLI probe: %j',
    async (control) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
      const { runProcess } = await import('../../shared/child-process/run-process')
      vi.mocked(runProcess).mockClear()
      await expect(
        pinClaudeProfileTerminalCommand(`/opt/claude${control}echo injected`)
      ).rejects.toThrow('direct Claude')
      expect(runProcess).not.toHaveBeenCalled()
    }
  )
  it('preserves exact safe raw suffix quoting and spacing', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const suffix = `  --model "space model"  --prompt 'literal $HOME; data'  `
    await expect(pinClaudeProfileTerminalCommand(`/opt/claude${suffix}`)).resolves.toBe(
      `'/opt/claude'${suffix}`
    )
  })
  it('pins the executable while preserving ordinary arguments on Linux', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    await expect(pinClaudeProfileTerminalCommand('/opt/claude --model sonnet')).resolves.toBe(
      "'/opt/claude' --model sonnet"
    )
  })
  it.each(['1.0.99', '2.0.76', 'unknown', 'wrapper 2.1.1'])(
    'refuses unverified scoped Keychain support: %s',
    (version) => {
      expect(supportsClaudeProfileKeychain(version)).toBe(false)
    }
  )
  it.each(['2.1.0 (Claude Code)', '2.1.280', '3.0.0'])(
    'accepts scoped Keychain support: %s',
    (version) => {
      expect(supportsClaudeProfileKeychain(version)).toBe(true)
    }
  )
  it.each([
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'ANTHROPIC_BASE_URL'
  ])('rejects explicit provider routing and strips inherited %s', (key) => {
    expect(() => assertClaudeProfileEnvironment({ [key]: '1' })).toThrow('override')
    const env = { [key]: '1', PATH: '/bin' }
    stripClaudeProfileProviderEnvironment(env)
    expect(env).toEqual({ PATH: '/bin' })
    expect(
      buildClaudeChildProcessEnv(
        { CLAUDE_CONFIG_DIR: '/profile' },
        {
          inheritedEnv: { [key]: '1' },
          isolatedCredentials: true,
          scrubConfiguredChildSessionStamps: true
        }
      )
    ).toEqual({ CLAUDE_CONFIG_DIR: '/profile' })
  })
})
