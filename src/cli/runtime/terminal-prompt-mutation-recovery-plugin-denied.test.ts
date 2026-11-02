import { describe, expect, it } from 'vitest'
import { attachDurableMutationRecovery } from './terminal-prompt-mutation-recovery'
import { RuntimeClientError } from './types'

describe('a plugin hook denial in the CLI', () => {
  it('gets no retry advice in the CLI', () => {
    const denied = new RuntimeClientError(
      'denied_by_plugin',
      'terminal.send denied by plugin a.b: x'
    )
    expect(
      attachDurableMutationRecovery(denied, 'req-1', ['terminal', 'send'], 'terminal.send')
    ).toBe(denied)
    const other = attachDurableMutationRecovery(
      new RuntimeClientError('runtime_error', 'boom'),
      'req-1',
      ['terminal', 'send'],
      'terminal.send'
    )
    expect(String(other)).toMatch(/--retry-request req-1/)
  })
})
