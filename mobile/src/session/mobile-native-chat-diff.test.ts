import { describe, expect, it } from 'vitest'
import { diffFromText, diffFromToolCall } from './mobile-native-chat-diff'

describe('diffFromToolCall', () => {
  it('builds del/add lines from an Edit tool call', () => {
    const lines = diffFromToolCall('Edit', {
      file_path: 'src/a.ts',
      old_string: 'const a = 1\nconst b = 2',
      new_string: 'const a = 10'
    })
    expect(lines).toEqual([
      { kind: 'meta', text: 'src/a.ts' },
      { kind: 'del', text: 'const a = 1' },
      { kind: 'del', text: 'const b = 2' },
      { kind: 'add', text: 'const a = 10' }
    ])
  })

  it('returns null for non-edit tools', () => {
    expect(diffFromToolCall('Bash', { command: 'ls' })).toBeNull()
  })
})

describe('diffFromText', () => {
  it('parses unified diff lines with colours', () => {
    const lines = diffFromText('@@ -1,2 +1,2 @@\n context\n-old\n+new')
    expect(lines).toEqual([
      { kind: 'meta', text: '@@ -1,2 +1,2 @@' },
      { kind: 'context', text: ' context' },
      { kind: 'del', text: 'old' },
      { kind: 'add', text: 'new' }
    ])
  })

  it('does not treat ordinary prose as a diff', () => {
    expect(diffFromText('Here is a list:\n- one bullet\nthat is all')).toBeNull()
  })

  it('caps large diffs before creating render rows', () => {
    const text = Array.from(
      { length: 1_000 },
      (_unused, index) => `${index % 2 === 0 ? '+' : '-'}line-${index}`
    ).join('\n')
    const lines = diffFromText(text)

    expect(lines).toHaveLength(120)
    expect(lines?.at(-1)).toEqual({ kind: 'meta', text: '… diff truncated …' })
  })

  it('honors a smaller caller-owned aggregate row budget', () => {
    const text = Array.from(
      { length: 100 },
      (_unused, index) => `${index % 2 === 0 ? '+' : '-'}line-${index}`
    ).join('\n')

    expect(diffFromText(text, 20)).toHaveLength(20)
  })
})
