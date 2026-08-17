import { describe, expect, it } from 'vitest'
import { parseRemoteCliArgs } from './ssh-remote-cli-args'
import {
  REPEATED_FLAG_SEPARATOR,
  foldRemoteFlagOccurrences,
  isRemoteBooleanFlag,
  remoteRepeatableFlags
} from './ssh-remote-cli-command-grammar'

describe('SSH remote command grammar', () => {
  it('keeps the global boolean flags boolean for every command', () => {
    for (const flag of ['json', 'help', 'all', 'current', 'updates', 'hide-diff', 'wait']) {
      expect(isRemoteBooleanFlag(flag, [])).toBe(true)
      expect(isRemoteBooleanFlag(flag, ['linear', 'project', 'create'])).toBe(true)
    }
  })

  it('scopes --activity to Linear issue reads only', () => {
    expect(isRemoteBooleanFlag('activity', ['linear', 'issue', 'ENG-123'])).toBe(true)
    expect(isRemoteBooleanFlag('activity', ['android', 'launch'])).toBe(false)
    expect(isRemoteBooleanFlag('activity', ['linear'])).toBe(false)
  })

  it('declares repeatable flags per command instead of globally', () => {
    expect([...remoteRepeatableFlags(['linear', 'project', 'create'])].sort()).toEqual([
      'label',
      'member',
      'team'
    ])
    expect([...remoteRepeatableFlags(['linear', 'label', 'add', 'ENG-1'])]).toEqual(['label'])
    expect([...remoteRepeatableFlags(['linear', 'project', 'update', 'add'])]).toEqual([])
    expect([...remoteRepeatableFlags(['tab', 'profile', 'create'])]).toEqual([])
  })

  it('folds only declared repeatable flags and keeps last-value-wins elsewhere', () => {
    const folded = foldRemoteFlagOccurrences(
      ['linear', 'project', 'create'],
      [
        { name: 'team', value: 'ENG' },
        { name: 'team', value: 'DES' },
        { name: 'name', value: 'First' },
        { name: 'name', value: 'Second' }
      ]
    )

    expect(folded.get('team')).toBe(`ENG${REPEATED_FLAG_SEPARATOR}DES`)
    expect(folded.get('name')).toBe('Second')
  })

  it('does not leak project-create repeatability into other commands', () => {
    const issueCreate = parseRemoteCliArgs([
      'linear',
      'create',
      '--title',
      'Fix',
      '--team',
      'ENG',
      '--team',
      'DES'
    ])
    const updateAdd = parseRemoteCliArgs([
      'linear',
      'project',
      'update',
      'add',
      'launch',
      '--body',
      'a',
      '--body',
      'b'
    ])

    expect(issueCreate.flags.get('team')).toBe('DES')
    expect(updateAdd.flags.get('body')).toBe('b')
  })
})

describe('SSH remote command grammar regressions for existing commands', () => {
  it('keeps --label folding for the issue label write commands', () => {
    for (const mode of ['add', 'remove', 'set']) {
      const parsed = parseRemoteCliArgs([
        'linear',
        'label',
        mode,
        'ENG-123',
        '--label',
        'Bug',
        '--label',
        'Growth'
      ])
      expect(parsed.flags.get('label')).toBe(`Bug${REPEATED_FLAG_SEPARATOR}Growth`)
      expect(parsed.commandPath).toEqual(['linear', 'label', mode, 'ENG-123'])
    }
  })

  it('keeps --label folding for linear create and save-issue, but not list-issues', () => {
    const expected = `Bug${REPEATED_FLAG_SEPARATOR}Growth`
    const create = parseRemoteCliArgs([
      'linear',
      'create',
      '--title',
      'Fix',
      '--label',
      'Bug',
      '--label',
      'Growth'
    ])
    const saveIssue = parseRemoteCliArgs([
      'linear',
      'save-issue',
      'ENG-123',
      '--label',
      'Bug',
      '--label',
      'Growth'
    ])
    const listIssues = parseRemoteCliArgs([
      'linear',
      'list-issues',
      '--label',
      'Bug',
      '--label',
      'Growth'
    ])

    expect(create.flags.get('label')).toBe(expected)
    expect(saveIssue.flags.get('label')).toBe(expected)
    // Why: list-issues reads a single --label, so folding would send it a NUL-joined string.
    expect(listIssues.flags.get('label')).toBe('Growth')
  })

  it('keeps --activity boolean for linear issue and valued for android launch', () => {
    const issue = parseRemoteCliArgs(['linear', 'issue', 'ENG-123', '--activity', '--full'])
    const launch = parseRemoteCliArgs([
      'android',
      'launch',
      '--activity',
      'com.example/.MainActivity'
    ])

    expect(issue.flags.get('activity')).toBe(true)
    expect(issue.commandPath).toEqual(['linear', 'issue', 'ENG-123'])
    expect(launch.flags.get('activity')).toBe('com.example/.MainActivity')
    expect(launch.commandPath).toEqual(['android', 'launch'])
  })

  it('keeps --flag=value parsing, trailing boolean flags and positional order', () => {
    const parsed = parseRemoteCliArgs([
      'terminal',
      'send',
      'term_1',
      '--text=--help',
      '--wait',
      '--json'
    ])

    expect(parsed.commandPath).toEqual(['terminal', 'send', 'term_1'])
    expect(parsed.flags.get('text')).toBe('--help')
    expect(parsed.flags.get('wait')).toBe(true)
    expect(parsed.flags.get('json')).toBe(true)
  })

  it('keeps last-value-wins for repeated non-repeatable flags', () => {
    const parsed = parseRemoteCliArgs(['worktree', 'create', '--repo', 'a', '--repo', 'b'])

    expect(parsed.flags.get('repo')).toBe('b')
  })
})
