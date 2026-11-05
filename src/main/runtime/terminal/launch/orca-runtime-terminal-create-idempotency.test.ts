import { describe, expect, it } from 'vitest'

import type { RuntimeTerminalCreate } from '../../../../shared/runtime-terminal-create-contract'

import { RemoteRuntimeTerminalCreateIdempotency } from '../identity/remote-runtime-terminal-create-idempotency'

function createdTerminal(handle: string, worktreeId = 'worktree-1'): RuntimeTerminalCreate {
  return { handle, worktreeId, title: null }
}

describe('terminal create idempotency', () => {
  it('bounds concurrent creates and releases capacity after settlement', async () => {
    const idempotency = new RemoteRuntimeTerminalCreateIdempotency(1)
    let resolveFirst: (value: RuntimeTerminalCreate) => void = () => {}
    const first = idempotency.run(
      'device-a',
      'worktree-1',
      'mutation-1',
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )

    await expect(
      idempotency.run('device-a', 'worktree-1', 'mutation-2', async () =>
        createdTerminal('terminal-2')
      )
    ).rejects.toThrow('Too many terminal creations')
    resolveFirst(createdTerminal('terminal-1'))
    await first
    await expect(
      idempotency.run('device-a', 'worktree-1', 'mutation-2', async () =>
        createdTerminal('terminal-2')
      )
    ).resolves.toEqual(createdTerminal('terminal-2'))
  })
})

// Match inventory scope: undefined aggregates and drops SSH failures; local is local-only; ssh scopes/rethrows failures.
