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
