import { describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { prepareAgentProfileTerminalCommand } from './terminal-command'
import type { PreparedAgentProfile } from './connection-contracts'

function prepared(managed = true): PreparedAgentProfile {
  return {
    snapshot: {
      id: 'p',
      name: 'Work',
      agent: 'claude',
      hostId: 'local',
      executable: '/bin/printf',
      binding: managed
        ? { kind: 'managed', accountId: 'a' }
        : { kind: 'external', home: '/space home' },
      resolvedHome: '/space home',
      identity: { kind: 'unverified', reason: 'fixture' }
    },
    envPatch: { CLAUDE_CONFIG_DIR: '/space home' },
    envToDelete: managed ? ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK'] : [],
    release: () => {}
  }
}

describe('profile terminal command', () => {
  it('pins canonical filenames, retains argv, and exposes agent recognition', () => {
    const result = prepareAgentProfileTerminalCommand(prepared(), 'claude --model "a b"')
    expect(result.launchAgent).toBe('claude')
    expect(result.command).toContain("'/bin/printf' '--model' 'a b'")
  })
  it.each([
    'env claude',
    'claude | cat',
    'claude; touch /tmp/sentinel',
    'claude $(touch /tmp/sentinel)',
    'claude `id`',
    'CLAUDE_CONFIG_DIR=/other claude',
    'claude --settings /other'
  ])('refuses unsafe routing: %s', (command) => {
    expect(() => prepareAgentProfileTerminalCommand(prepared(), command)).toThrow()
  })
  it('rejects explicit home and managed auth env overrides', () => {
    expect(() =>
      prepareAgentProfileTerminalCommand(prepared(), 'claude', { CLAUDE_CONFIG_DIR: '/other' })
    ).toThrow()
    expect(() =>
      prepareAgentProfileTerminalCommand(prepared(), 'claude', { ANTHROPIC_API_KEY: 'override' })
    ).toThrow()
    expect(() =>
      prepareAgentProfileTerminalCommand(prepared(false), 'claude', {
        ANTHROPIC_API_KEY: 'external'
      })
    ).not.toThrow()
  })
  it.skipIf(process.platform === 'win32')(
    'restores bound home and deletions after shell startup exports',
    async () => {
      const profile = prepared()
      profile.snapshot.executable = '/usr/bin/env'
      const { command } = prepareAgentProfileTerminalCommand(profile, 'claude')
      const result = await runProcess({
        program: '/bin/sh',
        args: [
          '-c',
          `export CLAUDE_CONFIG_DIR=/wrong ANTHROPIC_API_KEY=wrong CLAUDE_CODE_USE_BEDROCK=1; ${command}`
        ]
      })
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('CLAUDE_CONFIG_DIR=/space home')
      expect(result.stdout).not.toContain('ANTHROPIC_API_KEY=')
      expect(result.stdout).not.toContain('CLAUDE_CODE_USE_BEDROCK=')
    }
  )
})

it('keeps quoted arguments literal and rejects Codex auth configuration overrides', () => {
  const profile = prepared()
  profile.snapshot.agent = 'codex'
  profile.envPatch = { CODEX_HOME: '/codex home' }
  for (const command of [
    'codex -c model_provider=evil',
    'codex --profile other',
    'codex --config cli_auth_credentials_store=keyring',
    'codex --oss',
    'codex -c'
  ]) {
    expect(() => prepareAgentProfileTerminalCommand(profile, command)).toThrow()
  }
  expect(
    prepareAgentProfileTerminalCommand(
      profile,
      'codex --model "space model" -c model_reasoning_effort=high'
    ).command
  ).toContain("'model_reasoning_effort=high'")
})

it.each([
  'codex -c model_provider=custom',
  'codex --profile work',
  'codex --oss --local-provider ollama',
  'codex --config cli_auth_credentials_store=keyring'
])('preserves external Codex provider options with pinned home and executable: %s', (command) => {
  const profile = prepared(false)
  profile.snapshot.agent = 'codex'
  profile.envPatch = { CODEX_HOME: '/external home' }
  const bound = prepareAgentProfileTerminalCommand(profile, command)
  expect(bound.launchAgent).toBe('codex')
  expect(bound.command).toContain("'CODEX_HOME=/external home' '/bin/printf'")
  expect(bound.command).toContain(command.split(' ').at(-1))
  expect(() =>
    prepareAgentProfileTerminalCommand(profile, command, { CODEX_HOME: '/other' })
  ).toThrow()
  expect(() =>
    prepareAgentProfileTerminalCommand(profile, command.replace('codex', '/other/cli'))
  ).toThrow()
})

it('allows external Claude provider settings but refuses settings that can change its home', () => {
  const profile = prepared(false)
  const command = `claude --settings '{"env":{"ANTHROPIC_BASE_URL":"https://custom.invalid","ANTHROPIC_API_KEY":"external"}}'`
  expect(prepareAgentProfileTerminalCommand(profile, command).command).toContain(
    'ANTHROPIC_BASE_URL'
  )
  expect(() => prepareAgentProfileTerminalCommand(prepared(), command)).toThrow()
  for (const settings of [
    '{"env":{"CLAUDE_CONFIG_DIR":"/other"}}',
    '{"env":{"claude_config_dir":"/other"}}',
    '/mutable/settings.json',
    'invalid'
  ]) {
    expect(() =>
      prepareAgentProfileTerminalCommand(profile, `claude --settings '${settings}'`)
    ).toThrow()
  }
})

it('pins file auth for a managed Codex terminal and refuses cwd redirection', () => {
  const profile = prepared()
  profile.snapshot.agent = 'codex'
  profile.envPatch = { CODEX_HOME: '/owned' }
  expect(prepareAgentProfileTerminalCommand(profile, 'codex').command).toContain(
    'cli_auth_credentials_store="file"'
  )
  expect(() => prepareAgentProfileTerminalCommand(profile, 'codex --cd /elsewhere')).toThrow()
  expect(() => prepareAgentProfileTerminalCommand(profile, 'codex -C/elsewhere')).toThrow()
})
