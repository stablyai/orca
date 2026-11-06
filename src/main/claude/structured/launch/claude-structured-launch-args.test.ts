import { describe, expect, it } from 'vitest'
import {
  claudeStructuredLaunchArgs,
  withClaudeSourceTerminalArgs
} from './claude-structured-launch-args'
import { StructuredAgentArgumentsError } from '../../../native-chat/structured-agent-arguments-error'

const configured = () => claudeStructuredLaunchArgs(['--model', 'sonnet', '--add-dir', '/cfg'])

describe('withClaudeSourceTerminalArgs', () => {
  it('keeps expressible terminal args when one flag repeats or absorbs a positional', () => {
    const merged = withClaudeSourceTerminalArgs(configured(), [
      '--model',
      'opus',
      '--model',
      'sonnet',
      '--mcp-config',
      '/work/mcp.json',
      'fix the login bug',
      '--dangerously-load-development-channels',
      'server:relay'
    ])

    expect(merged.extraArgs).toEqual({
      model: 'sonnet',
      'mcp-config': '/work/mcp.json',
      'dangerously-load-development-channels': 'server:relay'
    })
    expect(merged.additionalDirectories).toEqual(['/cfg'])
  })

  it('lets the terminal value win a configured flag and still strips owned flags', () => {
    const merged = withClaudeSourceTerminalArgs(configured(), [
      '--model',
      'opus',
      '--resume',
      'old-session',
      '--fork-session',
      '--permission-mode',
      'bypassPermissions'
    ])

    expect(merged.extraArgs).toEqual({ model: 'opus' })
  })

  it('drops positionals absorbed by valueless flags instead of re-emitting them as prompts', () => {
    const merged = withClaudeSourceTerminalArgs(configured(), [
      '--strict-mcp-config',
      'fix the login bug',
      '--model',
      'opus'
    ])

    expect(merged.extraArgs).toEqual({ model: 'opus', 'strict-mcp-config': null })
  })

  it('skips valueless flags written in = form, which cannot round-trip through extraArgs', () => {
    const merged = withClaudeSourceTerminalArgs(configured(), [
      '--strict-mcp-config=true',
      '--bare',
      '--no-chrome'
    ])

    expect(merged.extraArgs).toEqual({ model: 'sonnet', bare: null, 'no-chrome': null })
  })

  it('returns the configured args when the terminal recorded none', () => {
    expect(withClaudeSourceTerminalArgs(configured(), undefined)).toEqual(configured())
    expect(withClaudeSourceTerminalArgs(configured(), [])).toEqual(configured())
  })
})

describe('claudeStructuredLaunchArgs', () => {
  it('still rejects repetitions and absorbed positionals for configured args', () => {
    expect(() => claudeStructuredLaunchArgs(['--model', 'opus', '--model', 'sonnet'])).toThrow(
      StructuredAgentArgumentsError
    )
    expect(() => claudeStructuredLaunchArgs(['--mcp-config', '/a.json', 'a prompt'])).toThrow(
      StructuredAgentArgumentsError
    )
  })
})
