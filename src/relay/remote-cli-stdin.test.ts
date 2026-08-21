import { describe, expect, it } from 'vitest'
import { shouldReadRemoteCliStdin } from './remote-cli-stdin'

describe('shouldReadRemoteCliStdin', () => {
  it('reads stdin only for body-file stdin requests', () => {
    expect(shouldReadRemoteCliStdin(['linear', 'comment', 'add', '--body-file', '-'])).toBe(true)
    expect(shouldReadRemoteCliStdin(['linear', 'create', '--body-file=-'])).toBe(true)
    expect(shouldReadRemoteCliStdin(['status'])).toBe(false)
    expect(shouldReadRemoteCliStdin(['linear', 'comment', 'add', '--body', 'done'])).toBe(false)
    expect(shouldReadRemoteCliStdin(['linear', 'issue', '--body-file', '-'])).toBe(false)
    expect(
      shouldReadRemoteCliStdin(['linear', 'comment', 'add', '--help', '--body-file', '-'])
    ).toBe(false)
    expect(shouldReadRemoteCliStdin(['linear', 'comment', 'add', '--body-file', 'body.md'])).toBe(
      false
    )
  })

  it('reads stdin for a Linear project update post piped over the relay', () => {
    expect(
      shouldReadRemoteCliStdin(['linear', 'project', 'update', 'add', 'launch', '--body-file', '-'])
    ).toBe(true)
    expect(
      shouldReadRemoteCliStdin(['linear', 'project', 'update', 'add', 'launch', '--body-file=-'])
    ).toBe(true)
    expect(
      shouldReadRemoteCliStdin(['linear', 'project', 'update', 'add', '--body', 'shipped'])
    ).toBe(false)
    // Why: reads take no stdin, so a stray --body-file must not block on it.
    expect(shouldReadRemoteCliStdin(['linear', 'project', 'show', '--body-file', '-'])).toBe(false)
  })

  it('reads stdin for a Linear project create piped over the relay', () => {
    expect(
      shouldReadRemoteCliStdin([
        'linear',
        'project',
        'create',
        '--name',
        'Launch',
        '--team',
        'ENG',
        '--content-file',
        '-'
      ])
    ).toBe(true)
    expect(
      shouldReadRemoteCliStdin(['linear', 'project', 'create', '--name', 'L', '--content-file=-'])
    ).toBe(true)
    expect(
      shouldReadRemoteCliStdin([
        'linear',
        'project',
        'create',
        '--name',
        'L',
        '--content-file',
        'overview.md'
      ])
    ).toBe(false)
  })

  it('reads stdin for a Linear project edit piped over the relay', () => {
    expect(
      shouldReadRemoteCliStdin(['linear', 'project', 'edit', 'launch', '--content-file', '-'])
    ).toBe(true)
    expect(
      shouldReadRemoteCliStdin(['linear', 'project', 'edit', 'launch', '--clear-content'])
    ).toBe(false)
  })

  // Why: every no-value `--clear-*` flag has to be in the parser's boolean-flag
  // table, or the positional that follows it gets mistaken for its value.
  it.each([
    'clear-description',
    'clear-lead',
    'clear-members',
    'clear-labels',
    'clear-start-date',
    'clear-target-date'
  ])('still detects piped content past --%s', (clearFlag) => {
    expect(
      shouldReadRemoteCliStdin([
        'linear',
        'project',
        'edit',
        'launch',
        `--${clearFlag}`,
        '--content-file',
        '-'
      ])
    ).toBe(true)
  })

  it('still detects piped content past --hide-diff on project update add', () => {
    expect(
      shouldReadRemoteCliStdin([
        'linear',
        'project',
        'update',
        'add',
        'launch',
        '--hide-diff',
        '--body-file',
        '-'
      ])
    ).toBe(true)
  })

  it('reads stdin for a Linear save-issue description piped over the relay', () => {
    expect(shouldReadRemoteCliStdin(['linear', 'save-issue', 'ENG-123', '--body-file', '-'])).toBe(
      true
    )
    expect(shouldReadRemoteCliStdin(['linear', 'save-issue', 'ENG-123', '--body-file=-'])).toBe(
      true
    )
    expect(
      shouldReadRemoteCliStdin(['linear', 'save-issue', 'ENG-123', '--description', 'done'])
    ).toBe(false)
  })

  it('reads stdin for *-stdin payload flags bridged to the full host CLI', () => {
    expect(shouldReadRemoteCliStdin(['computer', 'action', '--app', 'Notes', '--text-stdin'])).toBe(
      true
    )
    expect(shouldReadRemoteCliStdin(['computer', 'action', '--app', 'Notes', '--text', 'hi'])).toBe(
      false
    )
    expect(
      shouldReadRemoteCliStdin(['computer', 'action', '--app', 'Notes', '--text-stdin', '--help'])
    ).toBe(false)
  })
})
