import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  IDENTITY,
  record,
  makeExecutable
} from './claude-structured-launch-resolution.test-fixture'
import {
  createClaudeStructuredLaunchResolver,
  type ClaudeStructuredLaunchResolverDeps
} from './claude-structured-launch-resolution'
import { CLAUDE_THINKING_DISPLAY_FLAG, type ClaudeCliFlag } from './claude-cli-flag-support'
import { beginClaudeAuthSwitch, endClaudeAuthSwitch } from '../claude-accounts/live-pty-gate'
describe('readable Claude thinking', () => {
  const launchWith = (
    cliFlags?: ClaudeStructuredLaunchResolverDeps['cliFlags'],
    authSwitchSettleTimeoutMs?: number,
    command = '/usr/local/bin/claude',
    launchArgs: string[] = []
  ) =>
    createClaudeStructuredLaunchResolver({
      store: { getRecord: () => record(), pinLaunchDirectory: vi.fn() },
      resolveWorkspacePath: async (id) => `/repos/${id}`,
      resolveLaunchArgs: () => launchArgs,
      resolveCommand: () => command,
      resolveAuthPolicy: () => ({ stripAuthEnv: false }),
      resolveEnv: () => ({ PROJECT_SHIM: '1', ANTHROPIC_API_KEY: 'sk-user' }),
      hasTranscript: async () => false,
      ...(cliFlags ? { cliFlags } : {}),
      ...(authSwitchSettleTimeoutMs === undefined ? {} : { authSwitchSettleTimeoutMs })
    })({ identity: IDENTITY })

  // Whether the CLI's directory holds a `node` decides if the runtime pairing puts that directory
  // first on PATH (Linux CI's /usr/local/bin does, a Mac's usually does not), so both are pinned.
  it.each([
    ['without a sibling Node runtime', false],
    ['with a sibling Node runtime', true]
  ])(
    'probes the CLI the launch runs, on its PATH and shims, without its credentials (%s)',
    async (_, sibling) => {
      const supports = vi.fn(
        async (
          _flag: ClaudeCliFlag,
          _launch: { command: string; cwd: string; env: Record<string, string> }
        ) => true
      )
      const binDir = join(mkdtempSync(join(tmpdir(), 'orca-claude-probe-')), 'bin')
      const command = join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude')
      makeExecutable(command)
      if (sibling) {
        makeExecutable(join(binDir, process.platform === 'win32' ? 'node.cmd' : 'node'))
      }
      const launch = await launchWith({ supports }, undefined, command)
      const asked = supports.mock.calls[0]?.[1]
      expect(asked).toMatchObject({ command, cwd: '/repos/workspace-1' })
      const segments = (env: Record<string, string> | undefined) =>
        (env?.PATH ?? env?.Path ?? '').split(delimiter)
      // The launch's PATH is the probe's plus Orca's own CLI directory, which holds no `claude` or
      // runtime, so both resolve the same binary and the same shims in the same order.
      const orcaCliDir = launch.env?.ORCA_CLI_COMMAND ? dirname(launch.env.ORCA_CLI_COMMAND) : null
      expect(segments(launch.env).filter((dir) => dir !== orcaCliDir)).toEqual(segments(asked?.env))
      expect(segments(asked?.env)[0] === binDir).toBe(sibling)
      expect(asked?.env).toMatchObject({ PROJECT_SHIM: '1' })
      expect(asked?.env).not.toHaveProperty('ANTHROPIC_API_KEY')
      // The launch keeps the credential the user gave it.
      expect(launch.env).toMatchObject({ ANTHROPIC_API_KEY: 'sk-user' })
      expect(launch.options.extraArgs).toEqual({
        'replay-user-messages': null,
        'thinking-display': 'summarized'
      })
      expect(launch.options).not.toHaveProperty('thinking')
    }
  )

  it('passes nothing when the CLI is not known to take the flag, or nothing can say', async () => {
    const launch = await launchWith({ supports: async () => false })
    expect(launch.options.extraArgs).toEqual({ 'replay-user-messages': null })
    expect((await launchWith()).options.extraArgs).toEqual({ 'replay-user-messages': null })
  })

  it('keeps saved Arguments beside readable thinking, with the display left to Orca', async () => {
    const launch = await launchWith(
      { supports: async (flag) => flag === CLAUDE_THINKING_DISPLAY_FLAG },
      undefined,
      undefined,
      ['--effort', 'high', '--thinking-display', 'omitted']
    )
    expect(launch.options.extraArgs).toEqual({
      effort: 'high',
      'replay-user-messages': null,
      'thinking-display': 'summarized'
    })
  })

  it('still rechecks an account switch that began while the probe ran', async () => {
    try {
      const launch = launchWith(
        {
          supports: async () => {
            beginClaudeAuthSwitch()
            return false
          }
        },
        10
      )
      await expect(launch).rejects.toMatchObject({ reason: 'accountSwitchInProgress' })
    } finally {
      endClaudeAuthSwitch()
    }
  })
})
