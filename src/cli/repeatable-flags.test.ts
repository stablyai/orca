import { describe, expect, it } from 'vitest'

import { normalizeCommandPositionals, parseArgs, type CommandSpec } from './args'
import { REPEATED_FLAG_SEPARATOR, foldRepeatableFlags } from './repeatable-flags'
import { COMMAND_SPECS } from './specs'
import { getRepeatedStringFlag } from './flags'

function foldedFlags(argv: string[]): Map<string, string | boolean> {
  const resolved = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv))
  return foldRepeatableFlags(COMMAND_SPECS, resolved)
}

function collected(argv: string[], flag: string): string[] {
  return getRepeatedStringFlag(foldedFlags(argv), flag)
}

describe('command-scoped repeatable flags', () => {
  it('collects repeated --team for linear project create', () => {
    expect(
      collected(['linear', 'project', 'create', '--team', 'ENG', '--team', 'DESIGN'], 'team')
    ).toEqual(['ENG', 'DESIGN'])
  })

  it('collects repeated --member and --label for linear project create', () => {
    const flags = foldedFlags([
      'linear',
      'project',
      'create',
      '--member',
      'ada',
      '--member',
      'grace',
      '--label',
      'Platform',
      '--label=Q3'
    ])

    expect(getRepeatedStringFlag(flags, 'member')).toEqual(['ada', 'grace'])
    expect(getRepeatedStringFlag(flags, 'label')).toEqual(['Platform', 'Q3'])
  })

  it('keeps --team last-value-wins for existing single-team commands', () => {
    expect(foldedFlags(['linear', 'list', '--team', 'ENG', '--team', 'DESIGN']).get('team')).toBe(
      'DESIGN'
    )
    expect(
      foldedFlags(['linear', 'team', 'members', '--team', 'ENG', '--team', 'DESIGN']).get('team')
    ).toBe('DESIGN')
    expect(
      foldedFlags(['linear', 'create', '--title', 'x', '--team', 'ENG', '--team', 'DESIGN']).get(
        'team'
      )
    ).toBe('DESIGN')
  })

  it('keeps undeclared repeated flags last-value-wins', () => {
    expect(
      foldedFlags([
        'linear',
        'project',
        'create',
        '--name',
        'first',
        '--name',
        'second',
        '--workspace',
        'old',
        '--workspace',
        'new'
      ]).get('name')
    ).toBe('second')
    expect(
      foldedFlags(['linear', 'list', '--workspace', 'old', '--workspace', 'new']).get('workspace')
    ).toBe('new')
  })

  it('retains --label collection for every migrated label command', () => {
    for (const path of [
      ['linear', 'label', 'add'],
      ['linear', 'label', 'remove'],
      ['linear', 'label', 'set']
    ]) {
      expect(
        collected([...path, 'ENG-1', '--label', 'Bug', '--label', 'Regression'], 'label')
      ).toEqual(['Bug', 'Regression'])
    }
    expect(
      collected(
        ['linear', 'create', '--title', 'x', '--label', 'Bug', '--label', 'Regression'],
        'label'
      )
    ).toEqual(['Bug', 'Regression'])
    expect(
      collected(
        ['linear', 'save-issue', 'ENG-1', '--label', 'Bug', '--label', 'Regression'],
        'label'
      )
    ).toEqual(['Bug', 'Regression'])
  })

  it('retains --skill collection for every migrated skill command', () => {
    for (const path of [
      ['skills', 'share'],
      ['skills', 'install'],
      ['skills', 'update']
    ]) {
      expect(collected([...path, '--skill', 'alpha', '--skill', 'beta'], 'skill')).toEqual([
        'alpha',
        'beta'
      ])
    }
  })

  it('restores last-value-wins for commands that read a single --label', () => {
    expect(
      foldedFlags(['linear', 'list-issues', '--label', 'Bug', '--label', 'Regression']).get('label')
    ).toBe('Regression')
    expect(
      foldedFlags(['tab', 'profile', 'create', '--label', 'work', '--label', 'personal']).get(
        'label'
      )
    ).toBe('personal')
  })

  it('joins collected values with the repeated-flag separator', () => {
    expect(
      foldedFlags(['linear', 'project', 'create', '--team', 'ENG', '--team', 'DESIGN']).get('team')
    ).toBe(`ENG${REPEATED_FLAG_SEPARATOR}DESIGN`)
  })

  it('leaves a valueless repeatable flag as the boolean it parsed as', () => {
    expect(foldedFlags(['linear', 'project', 'create', '--team']).get('team')).toBe(true)
  })

  it('carries occurrences through positional normalization', () => {
    const resolved = normalizeCommandPositionals(
      COMMAND_SPECS,
      parseArgs(['linear', 'label', 'add', 'ENG-1', '--label', 'Bug', '--label', 'Regression'])
    )

    expect(resolved.commandPath).toEqual(['linear', 'label', 'add'])
    expect(resolved.flags.get('id')).toBe('ENG-1')
    expect(resolved.flagOccurrences?.get('label')).toEqual(['Bug', 'Regression'])
  })

  it('returns the parsed flag map untouched when nothing repeats', () => {
    const specs: CommandSpec[] = [
      { path: ['gadget', 'set'], summary: 's', usage: 'u', allowedFlags: [] }
    ]
    const resolved = normalizeCommandPositionals(specs, parseArgs(['gadget', 'set', '--to', 'a']))

    expect(foldRepeatableFlags(specs, resolved)).toBe(resolved.flags)
  })
})
