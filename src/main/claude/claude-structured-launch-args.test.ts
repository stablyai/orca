import { describe, expect, it } from 'vitest'
import { claudeStructuredLaunchArgs } from './claude-structured-launch-args'

describe('Claude structured launch arguments', () => {
  it('translates long flags, equals values, and the model short flag', () => {
    expect(
      claudeStructuredLaunchArgs([
        '-m',
        'opus',
        '--effort=high',
        '--chrome',
        '--add-dir',
        '/repo/other'
      ])
    ).toEqual({
      extraArgs: { model: 'opus', effort: 'high', chrome: null },
      additionalDirectories: ['/repo/other']
    })
  })

  it('removes SDK transport, permission, and lifecycle flags with their values', () => {
    expect(
      claudeStructuredLaunchArgs([
        '-p',
        '--input-format',
        'text',
        '--output-format=json',
        '--json-schema',
        '{}',
        '--verbose',
        '-r',
        'other-session',
        '-c',
        '--session-id=other-session',
        '--fork-session',
        '--permission-mode',
        'bypassPermissions',
        '--dangerously-skip-permissions',
        '--allow-dangerously-skip-permissions',
        '--permission-prompt-tool',
        'other',
        '--replay-user-messages',
        '--include-partial-messages',
        '--setting-sources',
        'none',
        '--system-prompt',
        'replacement',
        '--append-system-prompt-file=other.txt',
        '--model',
        'opus'
      ])
    ).toEqual({ extraArgs: { model: 'opus' }, additionalDirectories: [] })
  })

  it('ignores positional prompts and tokens after --', () => {
    expect(
      claudeStructuredLaunchArgs(['prompt', '--model', 'opus', '--', '--effort', 'high'])
    ).toEqual({
      extraArgs: { model: 'opus' },
      additionalDirectories: []
    })
  })
  it('keeps repeated and multi-value directory options in order', () => {
    expect(
      claudeStructuredLaunchArgs([
        '--add-dir',
        '/one',
        '/two',
        '--model',
        'opus',
        '--add-dir=/three',
        '/four'
      ])
    ).toEqual({
      extraArgs: { model: 'opus' },
      additionalDirectories: ['/one', '/two', '/three', '/four']
    })
  })

  it.each([
    ['--model', 'opus', '-m', 'sonnet'],
    ['--model', 'opus', 'sonnet'],
    ['--effort=high', 'medium'],
    ['--chrome', '--chrome'],
    ['--add-dir'],
    ['--add-dir=']
  ])('refuses options the SDK cannot preserve: %j', (...args) => {
    expect(() => claudeStructuredLaunchArgs(args)).toThrow(/Arguments/)
  })
})
