import { describe, expect, it } from 'vitest'

import { parseArgs } from '../args'

import { COMPUTER_COMMAND_SPECS } from './computer'

describe('computer command specs', () => {
  it('accepts snapshot IDs as values only on the three supported actions', () => {
    const supported = ['click', 'perform-secondary-action', 'set-value']
    for (const spec of COMPUTER_COMMAND_SPECS) {
      expect(spec.allowedFlags.includes('if-snapshot-id')).toBe(supported.includes(spec.path[1]))
    }
    const parsed = parseArgs(
      [
        'computer',
        'click',
        '--app',
        'Editor',
        '--element-index',
        '0',
        '--if-snapshot-id',
        'opaque-id'
      ],
      [['computer', 'click']],
      COMPUTER_COMMAND_SPECS
    )
    expect(parsed.flags.get('if-snapshot-id')).toBe('opaque-id')
  })

  it('does not advertise ignored worktree/session scoping for app and window listing', () => {
    const listApps = COMPUTER_COMMAND_SPECS.find(
      (spec) => spec.path.join(' ') === 'computer list-apps'
    )
    const listWindows = COMPUTER_COMMAND_SPECS.find(
      (spec) => spec.path.join(' ') === 'computer list-windows'
    )

    expect(listApps?.allowedFlags).not.toContain('worktree')
    expect(listApps?.usage).not.toContain('worktree')
    expect(listWindows?.allowedFlags).not.toContain('worktree')
    expect(listWindows?.allowedFlags).not.toContain('session')
    expect(listWindows?.usage).not.toContain('worktree')
    expect(listWindows?.usage).not.toContain('session')
  })

  it('allows explicit window targeting on action commands', () => {
    const actionSpecs = COMPUTER_COMMAND_SPECS.filter((spec) =>
      [
        'computer click',
        'computer drag',
        'computer hotkey',
        'computer paste-text',
        'computer perform-secondary-action',
        'computer press-key',
        'computer scroll',
        'computer set-value',
        'computer type-text'
      ].includes(spec.path.join(' '))
    )

    expect(actionSpecs).not.toHaveLength(0)
    for (const spec of actionSpecs) {
      expect(spec.allowedFlags).toEqual(expect.arrayContaining(['window-id', 'window-index']))
    }
  })

  it('advertises press-key as a single-key command', () => {
    const pressKey = COMPUTER_COMMAND_SPECS.find(
      (spec) => spec.path.join(' ') === 'computer press-key'
    )

    expect(pressKey?.summary).toContain('Press a single key')
    expect(pressKey?.summary).not.toContain('xdotool')
  })

  it('advertises targeted computer-use permission setup', () => {
    const permissions = COMPUTER_COMMAND_SPECS.find(
      (spec) => spec.path.join(' ') === 'computer permissions'
    )

    expect(permissions?.allowedFlags).toContain('id')
    expect(permissions?.usage).toContain('--id <accessibility|screenshots>')
  })
})
