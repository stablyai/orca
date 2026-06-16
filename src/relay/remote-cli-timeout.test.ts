import { describe, expect, it } from 'vitest'
import { remoteCliRequestTimeoutMs } from './remote-cli-timeout'

describe('remoteCliRequestTimeoutMs', () => {
  it('extends SSH remote CLI timeout for Linear issue context reads', () => {
    expect(
      remoteCliRequestTimeoutMs({
        argv: ['linear', 'issue', 'ENG-123', '--json']
      })
    ).toBe(120_000)
  })

  it('extends the timeout when global flags appear before the Linear command', () => {
    expect(
      remoteCliRequestTimeoutMs({
        argv: ['--json', 'linear', 'issue', 'ENG-123', '--workspace', 'workspace-1', '--full']
      })
    ).toBe(120_000)
  })

  it('extends SSH remote CLI timeout for Linear search', () => {
    expect(
      remoteCliRequestTimeoutMs({
        argv: ['linear', 'search', 'auth', '--limit', '1']
      })
    ).toBe(120_000)
  })

  it('extends the timeout when boolean flags appear between Linear and search', () => {
    expect(
      remoteCliRequestTimeoutMs({
        argv: ['linear', '--json', 'search', 'auth', '--limit', '1']
      })
    ).toBe(120_000)
  })

  it('extends the timeout when boolean flags appear between Linear and issue', () => {
    expect(
      remoteCliRequestTimeoutMs({
        argv: ['linear', '--json', 'issue', 'ENG-123', '--full']
      })
    ).toBe(120_000)
  })

  it('extends SSH remote CLI timeout for Linear writes', () => {
    for (const argv of [
      ['linear', 'status', 'set', 'ENG-123', '--to', 'Done'],
      ['linear', 'comment', 'add', 'ENG-123', '--body', 'Done'],
      ['linear', 'attach', 'ENG-123', '--url', 'https://example.invalid/review'],
      ['linear', 'create', '--team', 'ENG', '--title', 'Follow up']
    ]) {
      expect(remoteCliRequestTimeoutMs({ argv })).toBe(120_000)
    }
  })

  it('keeps ordinary remote CLI requests on the relay default timeout', () => {
    expect(remoteCliRequestTimeoutMs({ argv: ['status'] })).toBeUndefined()
  })
})
