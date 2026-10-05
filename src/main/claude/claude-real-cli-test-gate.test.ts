import { describe, expect, it, vi } from 'vitest'
import {
  REAL_CLAUDE_CLI_TEST_ENV,
  resolveRealClaudeCliGate,
  type ClaudeCliProbeResult
} from './claude-real-cli-test-gate'

/** A claude that is installed and signed in, as far as the probes can tell. */
function signedInClaude() {
  return vi.fn((args: readonly string[]): ClaudeCliProbeResult => {
    if (args[0] === '--version') {
      return { status: 0, stdout: '2.1.0 (Claude Code)\n' }
    }
    return {
      status: 0,
      stdout: JSON.stringify({ loggedIn: true, projectsDirectory: '/home/dev/.claude/projects' })
    }
  })
}

describe('resolveRealClaudeCliGate', () => {
  it.each([undefined, '', '0', 'true'])(
    'skips without probing a signed-in claude when %s is the opt-in value',
    (value) => {
      const runClaude = signedInClaude()

      const gate = resolveRealClaudeCliGate({ [REAL_CLAUDE_CLI_TEST_ENV]: value }, runClaude)

      expect(gate).toEqual({
        skipReason: 'set ORCA_REAL_CLAUDE_CLI_TEST=1 to run against the real claude CLI',
        authStatus: null
      })
      expect(runClaude).not.toHaveBeenCalled()
    }
  )

  it('runs with the CLI account report once opted in and signed in', () => {
    const runClaude = signedInClaude()

    const gate = resolveRealClaudeCliGate({ [REAL_CLAUDE_CLI_TEST_ENV]: '1' }, runClaude)

    expect(gate).toEqual({
      skipReason: null,
      authStatus: { loggedIn: true, projectsDirectory: '/home/dev/.claude/projects' }
    })
    expect(runClaude.mock.calls).toEqual([[['--version']], [['auth', 'status', '--json']]])
  })

  it('reads the final account report after the CLI configuration warning', () => {
    const warning = [
      'Claude configuration file not found at: /home/dev/.claude/.claude.json',
      'A backup file exists at: /home/dev/.claude/backups/.claude.json.backup.123',
      'You can manually restore it by running: cp /home/dev/.claude/backups/.claude.json.backup.123 /home/dev/.claude/.claude.json',
      ''
    ].join('\n')
    const runClaude = vi.fn((args: readonly string[]): ClaudeCliProbeResult =>
      args[0] === '--version'
        ? { status: 0, stdout: '2.1.0\n' }
        : { status: 0, stdout: warning + warning + JSON.stringify({ loggedIn: true }) }
    )

    expect(resolveRealClaudeCliGate({ [REAL_CLAUDE_CLI_TEST_ENV]: '1' }, runClaude)).toEqual({
      skipReason: null,
      authStatus: { loggedIn: true }
    })
  })

  it('still skips when opted in but no claude binary answers', () => {
    const runClaude = vi.fn((): ClaudeCliProbeResult => ({ status: null, stdout: '' }))

    const gate = resolveRealClaudeCliGate({ [REAL_CLAUDE_CLI_TEST_ENV]: '1' }, runClaude)

    expect(gate).toEqual({ skipReason: '`claude --version` failed', authStatus: null })
    expect(runClaude).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a failed auth probe', { status: 1, stdout: '' }],
    ['unparseable auth output', { status: 0, stdout: 'not json' }],
    ['malformed JSON', { status: 0, stdout: '{"loggedIn":' }],
    ['trailing output', { status: 0, stdout: '{"loggedIn":true}\nnot json' }],
    ['two JSON objects', { status: 0, stdout: '{"loggedIn":false}\n{"loggedIn":true}' }],
    ['another JSON value before an object', { status: 0, stdout: 'true\n{"loggedIn":true}' }],
    ['an array before an object', { status: 0, stdout: '[]\n{"loggedIn":true}' }],
    ['a JSON array', { status: 0, stdout: '[{"loggedIn":true}]' }],
    ['an unrelated JSON value', { status: 0, stdout: 'true' }]
  ])('runs with no account report after %s', (_label, authResult) => {
    const runClaude = vi.fn((args: readonly string[]): ClaudeCliProbeResult =>
      args[0] === '--version' ? { status: 0, stdout: '2.1.0\n' } : authResult
    )

    // The suite's signed-out case still runs; its signed-in cases skip on a null report.
    expect(resolveRealClaudeCliGate({ [REAL_CLAUDE_CLI_TEST_ENV]: '1' }, runClaude)).toEqual({
      skipReason: null,
      authStatus: null
    })
  })

  it('keeps only the account fields it understands', () => {
    const runClaude = vi.fn((args: readonly string[]): ClaudeCliProbeResult =>
      args[0] === '--version'
        ? { status: 0, stdout: '2.1.0\n' }
        : { status: 0, stdout: JSON.stringify({ loggedIn: 'yes', projectsDirectory: 7 }) }
    )

    expect(resolveRealClaudeCliGate({ [REAL_CLAUDE_CLI_TEST_ENV]: '1' }, runClaude)).toEqual({
      skipReason: null,
      authStatus: {}
    })
  })
})
