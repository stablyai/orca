import { describe, expect, it } from 'vitest'
import { assertSshMutationExpectation } from './ssh-connection-generation'

describe('SSH connection generation session scope', () => {
  it('rejects an SSH execution-host expectation when direct IPC resolves locally', () => {
    expect(() =>
      assertSshMutationExpectation(undefined, undefined, undefined, 'ssh:ssh-a')
    ).toThrow('Workspace host changed; refresh and try again')
  })

  it('rejects a local execution-host expectation when direct IPC resolves through SSH', () => {
    expect(() => assertSshMutationExpectation('ssh-a', 'ssh-a', 0, 'local')).toThrow(
      'Workspace host changed; refresh and try again'
    )
  })
})
