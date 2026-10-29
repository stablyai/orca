import { afterEach, describe, expect, it } from 'vitest'
import { inferClaudeAccountIdFromTranscript } from './claude-pane-account-registry'
import { resolveClaudeAccountHome } from './claude-account-home-attribution'

const accounts = [{ id: 'b' }]
const home = () => 'C:\\Users\\Owner\\Claude\\'
const platform = process.platform
afterEach(() => Object.defineProperty(process, 'platform', { configurable: true, value: platform }))

describe('Claude account home attribution', () => {
  it('folds Windows case for both live and transcript attribution', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    expect(resolveClaudeAccountHome('c:/users/owner/claude/', accounts, home)).toBe('b')
    expect(
      inferClaudeAccountIdFromTranscript('c:/users/owner/claude/projects/repo/s.jsonl', [
        { id: 'b', homes: [home()] }
      ])
    ).toEqual({ accountId: 'b', configDir: 'c:/users/owner/claude' })
  })

  it('preserves case on Linux and skips invalid account homes', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    expect(resolveClaudeAccountHome('/home/B', accounts, () => '/home/b')).toBeNull()
    expect(
      inferClaudeAccountIdFromTranscript('/home/B/projects/repo/s.jsonl', [
        { id: 'b', homes: ['/home/b'] }
      ])
    ).toBeNull()
    expect(
      resolveClaudeAccountHome('/home/b', [{ id: 'bad' }, ...accounts], (id) => {
        if (id === 'bad') {
          throw new Error('invalid id')
        }
        return '/home/b'
      })
    ).toBe('b')
  })
})
