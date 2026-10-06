import { describe, expect, it, vi } from 'vitest'
import { planLaunchForTest } from '../../shared/launch-prompt-plan.test-fixture'
import { buildAgentResumeStartupPlan } from '../../shared/tui-agent-startup'
import { buildAiVaultResumeShellCommand } from '../../shared/ai-vault-resume-command'
import { resolveQoderTerminalCommand } from './qoder-terminal-command-resolution'

vi.mock('../preflight/agent-detection', () => ({ detectAgentCommandsOnHost: vi.fn() }))

describe('execution-host Qoder command selection', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'starts and resumes modern-only and legacy-only installs on %s',
    async (platform) => {
      const startup = planLaunchForTest({
        agent: 'qoder',
        prompt: 'qodercli is a prompt word',
        cmdOverrides: {},
        platform
      })
      const resume = buildAgentResumeStartupPlan({
        agent: 'qoder',
        providerSession: { key: 'session_id', id: 'existing-session' },
        cmdOverrides: {},
        platform
      })
      if (!startup || !resume) {
        throw new Error('Missing Qoder plans')
      }
      const shell = platform === 'win32' ? 'powershell' : 'posix'
      for (const found of [
        new Set(['qoder']),
        new Set(['qodercli']),
        new Set(['qoder', 'qodercli'])
      ]) {
        const selected = found.has('qodercli') ? 'qodercli' : 'qoder'
        const detect = vi.fn(async () => found)
        for (const plan of [startup, resume]) {
          const result = await resolveQoderTerminalCommand(
            { launchAgent: 'qoder', command: plan.launchCommand, launchConfig: plan.launchConfig },
            { shell },
            detect
          )
          expect(result.command).toBe(plan.launchCommand.replace(/^qodercli/, selected))
          expect(result.launchConfig?.agentCommand).toBe(selected)
        }
        const historyCommand = buildAiVaultResumeShellCommand({
          resumeCommand: resume.launchCommand,
          cwd: '/folder workspace',
          platform,
          shell
        })
        const history = await resolveQoderTerminalCommand(
          { launchAgent: 'qoder', command: historyCommand, launchConfig: resume.launchConfig },
          { shell },
          detect
        )
        expect(history.command).toBe(historyCommand.replace(/qodercli(?=\s)/, selected))
      }
    }
  )

  it('queries each execution host without sharing a result or falling back after contact loss', async () => {
    const options = { launchAgent: 'qoder' as const, command: 'qodercli --resume existing-session' }
    const detect = vi
      .fn()
      .mockResolvedValueOnce(new Set(['qoder']))
      .mockResolvedValueOnce(new Set(['qodercli']))
      .mockRejectedValueOnce(new Error('Host disconnected'))
    const wsl = { shell: 'posix' as const, context: { wslDistro: 'Ubuntu' } }
    const ssh = { shell: 'posix' as const, connectionId: 'ssh-host' }
    expect((await resolveQoderTerminalCommand(options, wsl, detect)).command).toBe(
      'qoder --resume existing-session'
    )
    expect((await resolveQoderTerminalCommand(options, ssh, detect)).command).toBe(options.command)
    await expect(resolveQoderTerminalCommand(options, ssh, detect)).rejects.toThrow(
      'Host disconnected'
    )
    expect(detect.mock.calls).toEqual([
      [['qodercli', 'qoder'], wsl],
      [['qodercli', 'qoder'], ssh],
      [['qodercli', 'qoder'], ssh]
    ])
  })

  it.each([
    '/custom/qodercli --resume id',
    'qoder --prompt-interactive hello',
    'echo qodercli',
    'qodercli-other'
  ])('preserves explicit paths, modern commands and unrelated commands: %s', async (command) => {
    const detect = vi.fn()
    expect(
      (
        await resolveQoderTerminalCommand(
          { launchAgent: 'qoder', command },
          { shell: 'posix' },
          detect
        )
      ).command
    ).toBe(command)
    expect(detect).not.toHaveBeenCalled()
  })
})
