import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalQuickCommand } from '../../../../src/shared/terminal/quick-commands/terminal-quick-command-types'
import type { RpcClient } from '../../transport/rpc-client'
import '../../transport/stable-logical-rpc-client'

import type { RpcResponse } from '../../transport/types'
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

  it('adopts the latest server-normalized list between queued mutations', async () => {
    const normalizedFirst = { ...FIRST, label: 'Server normalized' }
    const firstUpdate = deferred<RpcResponse>()
    const secondUpdate = deferred<RpcResponse>()
    const updateParams: unknown[] = []
    const client = {
      sendRequest: vi.fn((method: string, params?: unknown) => {
        if (method === 'settings.getTerminalQuickCommands') {
          return Promise.resolve(success([FIRST, SECOND]))
        }
        updateParams.push(params)
        return updateParams.length === 1 ? firstUpdate.promise : secondUpdate.promise
      })
    } as unknown as RpcClient
    await mount(client)

    let firstPersist: Promise<boolean> = Promise.resolve(false)
    let secondPersist: Promise<boolean> = Promise.resolve(false)
    await act(async () => {
      firstPersist = state!.persist({
        type: 'upsert',
        command: { ...FIRST, label: 'Local label' }
      })
      secondPersist = state!.persist({ type: 'delete', id: SECOND.id })
      await Promise.resolve()
    })

    expect(updateParams[0]).toEqual({
      mutation: { type: 'upsert', command: { ...FIRST, label: 'Local label' } }
    })
    await act(async () => {
      firstUpdate.resolve(success([normalizedFirst, SECOND]))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(updateParams[1]).toEqual({ mutation: { type: 'delete', id: SECOND.id } })

    await act(async () => {
      secondUpdate.resolve(success([normalizedFirst]))
      await Promise.all([firstPersist, secondPersist])
    })
    expect(state?.commands).toEqual([normalizedFirst])
  })

  it('isolates an old client mutation from a replacement client', async () => {
    const oldUpdate = deferred<RpcResponse>()
    const oldClient = {
      sendRequest: vi
        .fn()
        .mockResolvedValueOnce(success([FIRST]))
        .mockReturnValueOnce(oldUpdate.promise)
    } as unknown as RpcClient
    const newClient = {
      sendRequest: vi.fn().mockResolvedValue(success([SECOND]))
    } as unknown as RpcClient

    function Harness({ client }: { client: RpcClient }): null {
      state = useQuickCommands({ client, enabled: true })
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness, { client: oldClient }))
      await Promise.resolve()
    })
    let persisted: Promise<boolean> = Promise.resolve(false)
    await act(async () => {
      persisted = state!.persist({ type: 'delete', id: FIRST.id })
      await Promise.resolve()
      renderer!.update(createElement(Harness, { client: newClient }))
      await Promise.resolve()
    })

    expect(newClient.sendRequest).toHaveBeenCalledWith('settings.getTerminalQuickCommands')
    expect(state?.commands).toEqual([SECOND])

    await act(async () => {
      oldUpdate.resolve(success([]))
      await persisted
    })
    expect(state?.commands).toEqual([SECOND])
  })

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
