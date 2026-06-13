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
})
