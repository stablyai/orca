import { describe, expect, it } from 'vitest'
import { mergeClaudeSettings, type ClaudeSettingsLedger } from './claude-settings-merge'

const none: ClaudeSettingsLedger = { scalars: {}, permissions: {} }
const json = (text: string | null) => (text === null ? null : JSON.parse(text))

describe('mergeClaudeSettings', () => {
  it('adds allowlisted keys and rules while keeping everything else in the file', () => {
    const current = JSON.stringify({
      env: { A: '1' },
      hooks: {},
      permissions: { allow: ['Bash(ls)'] }
    })
    const result = mergeClaudeSettings(
      current,
      {
        model: 'opus',
        permissions: { allow: ['Bash(npm test:*)', 'Bash(ls)'], deny: ['Read(.env)'] }
      },
      none
    )
    expect(result.kind).toBe('merged')
    if (result.kind !== 'merged') {
      return
    }
    expect(json(result.text)).toEqual({
      env: { A: '1' },
      hooks: {},
      model: 'opus',
      permissions: { allow: ['Bash(ls)', 'Bash(npm test:*)'], deny: ['Read(.env)'] }
    })
    // "Bash(ls)" was the sandbox's own: this computer is not responsible for it.
    expect(result.ledger).toEqual({
      scalars: { model: 'opus' },
      permissions: { allow: ['Bash(npm test:*)'], deny: ['Read(.env)'] }
    })
  })

  it('lets a value changed in the sandbox win, and stops owning it', () => {
    const ledger: ClaudeSettingsLedger = { scalars: { model: 'opus' }, permissions: {} }
    const result = mergeClaudeSettings(
      JSON.stringify({ model: 'haiku' }),
      { model: 'sonnet' },
      ledger
    )
    if (result.kind !== 'merged') {
      throw new Error('unexpected')
    }
    expect(result.text).toBeNull()
    expect(result.ledger.scalars).toEqual({})
  })

  it('removes only the rules and keys this computer added when it stops sending them', () => {
    const ledger: ClaudeSettingsLedger = {
      scalars: { model: 'opus' },
      permissions: { allow: ['Bash(npm test:*)'] }
    }
    const current = JSON.stringify({
      model: 'opus',
      permissions: { allow: ['Bash(ls)', 'Bash(npm test:*)'] }
    })
    const result = mergeClaudeSettings(current, {}, ledger)
    if (result.kind !== 'merged') {
      throw new Error('unexpected')
    }
    expect(json(result.text)).toEqual({ permissions: { allow: ['Bash(ls)'] } })
    expect(result.ledger).toEqual({ scalars: {}, permissions: {} })
  })

  it('creates the file when the sandbox has none, and leaves an unreadable one alone', () => {
    const created = mergeClaudeSettings(null, { includeCoAuthoredBy: false }, none)
    if (created.kind !== 'merged') {
      throw new Error('unexpected')
    }
    expect(json(created.text)).toEqual({ includeCoAuthoredBy: false })
    expect(mergeClaudeSettings('{ not json', { model: 'opus' }, none)).toEqual({
      kind: 'unreadable'
    })
    expect(mergeClaudeSettings('[1,2]', { model: 'opus' }, none)).toEqual({ kind: 'unreadable' })
  })

  it('writes nothing when everything is already in place', () => {
    const ledger: ClaudeSettingsLedger = { scalars: { model: 'opus' }, permissions: {} }
    const result = mergeClaudeSettings(JSON.stringify({ model: 'opus' }), { model: 'opus' }, ledger)
    if (result.kind !== 'merged') {
      throw new Error('unexpected')
    }
    expect(result.text).toBeNull()
  })
})
