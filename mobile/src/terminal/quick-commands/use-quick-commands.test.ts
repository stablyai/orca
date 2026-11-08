import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalQuickCommand } from '../../../../src/shared/terminal/quick-commands/terminal-quick-command-types'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'

import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import { useQuickCommands } from './use-quick-commands'

const FIRST: TerminalQuickCommand = {
  id: 'first',
  label: 'First',
  action: 'terminal-command',
  command: 'echo first',
  appendEnter: true,
  scope: { type: 'global' }
}
const SECOND: TerminalQuickCommand = {
  id: 'second',
  label: 'Second',
  action: 'terminal-command',
  command: 'echo second',
  appendEnter: true,
  scope: { type: 'global' }
}

function success(commands: TerminalQuickCommand[]): RpcResponse {
  return {
    ok: true,
    result: { terminalQuickCommands: commands }
  } as RpcResponse
}

function failure(message: string): RpcResponse {
  return {
    ok: false,
    error: { code: 'internal_error', message }
  } as RpcResponse
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('useQuickCommands', () => {
  let renderer: ReactTestRenderer | null = null
  let state: ReturnType<typeof useQuickCommands> | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    state = null
  })

  async function mount(client: RpcClient, enabled = true): Promise<void> {
    function Harness(): null {
      state = useQuickCommands({ client, enabled })
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
      await Promise.resolve()
    })
  }

  it('rolls back to the confirmed list when consecutive queued mutations fail', async () => {
    const firstUpdate = deferred<RpcResponse>()
    const secondUpdate = deferred<RpcResponse>()
    const client = {
      sendRequest: vi
        .fn()
        .mockResolvedValueOnce(success([FIRST, SECOND]))
        .mockReturnValueOnce(firstUpdate.promise)
        .mockReturnValueOnce(secondUpdate.promise)
    } as unknown as RpcClient
    await mount(client)

    let firstPersist: Promise<boolean> = Promise.resolve(false)
    let secondPersist: Promise<boolean> = Promise.resolve(false)
    await act(async () => {
      firstPersist = state!.persist({ type: 'delete', id: FIRST.id })
      secondPersist = state!.persist({ type: 'delete', id: SECOND.id })
      await Promise.resolve()
    })

    await act(async () => {
      firstUpdate.resolve(failure('first failed'))
      await Promise.resolve()
      await Promise.resolve()
      secondUpdate.resolve(failure('second failed'))
      await Promise.all([firstPersist, secondPersist])
    })

    expect(state?.commands).toEqual([FIRST, SECOND])
    expect(state?.error).toBe('second failed')
  })
})
