import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { TerminalQuickCommand } from '../../../src/shared/types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
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
  let consoleSpy: MockInstance

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const original = console.error
    consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    state = null
    consoleSpy.mockRestore()
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

  it('does not fetch settings while the sheet is closed', async () => {
    const client = { sendRequest: vi.fn() } as unknown as RpcClient

    await mount(client, false)

    expect(client.sendRequest).not.toHaveBeenCalled()
    expect(state?.ready).toBe(false)
  })

  it('keeps mutations disabled when the remote list could not be loaded', async () => {
    const client = {
      sendRequest: vi.fn().mockResolvedValue(failure('load failed'))
    } as unknown as RpcClient
    await mount(client)

    await act(async () => {
      const persisted = await state!.persist({ type: 'delete', id: FIRST.id })
      expect(persisted).toBe(false)
    })

    expect(state?.ready).toBe(false)
    expect(state?.error).toBe('load failed')
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
  })

  it('keeps mutations disabled when a successful load has a malformed list', async () => {
    const client = {
      sendRequest: vi.fn().mockResolvedValue({ ok: true, result: {} } as RpcResponse)
    } as unknown as RpcClient
    await mount(client)

    await act(async () => {
      const persisted = await state!.persist({ type: 'delete', id: FIRST.id })
      expect(persisted).toBe(false)
    })

    expect(state?.ready).toBe(false)
    expect(state?.error).toBe('Failed to load quick commands')
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
  })

  it('keeps a later queued mutation after an earlier mutation fails', async () => {
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
    expect(state?.commands).toEqual([FIRST, SECOND])

    let firstPersist: Promise<boolean> = Promise.resolve(false)
    let secondPersist: Promise<boolean> = Promise.resolve(false)
    await act(async () => {
      firstPersist = state!.persist({ type: 'delete', id: FIRST.id })
      secondPersist = state!.persist({ type: 'delete', id: SECOND.id })
      await Promise.resolve()
    })

    expect(state?.commands).toEqual([])
    expect(updateParams).toHaveLength(1)
    expect(updateParams[0]).toEqual({ mutation: { type: 'delete', id: FIRST.id } })

    await act(async () => {
      firstUpdate.resolve(failure('first failed'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(updateParams).toEqual([
      { mutation: { type: 'delete', id: FIRST.id } },
      { mutation: { type: 'delete', id: SECOND.id } }
    ])
    expect(state?.commands).toEqual([FIRST])

    await act(async () => {
      secondUpdate.resolve(success([FIRST]))
      await Promise.all([firstPersist, secondPersist])
    })
    expect(await firstPersist).toBe(false)
    expect(await secondPersist).toBe(true)
    expect(state?.commands).toEqual([FIRST])
    expect(state?.error).toBeNull()
  })

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

  it('preserves unrelated commands added by another client while the sheet is open', async () => {
    const edited = { ...FIRST, label: 'Edited on mobile' }
    const client = {
      sendRequest: vi
        .fn()
        .mockResolvedValueOnce(success([FIRST]))
        // The host applies the targeted upsert to a list that desktop changed.
        .mockResolvedValueOnce(success([edited, SECOND]))
    } as unknown as RpcClient
    await mount(client)

    await act(async () => {
      await state!.persist({ type: 'upsert', command: edited })
    })

    expect(client.sendRequest).toHaveBeenLastCalledWith('settings.updateTerminalQuickCommands', {
      mutation: { type: 'upsert', command: edited }
    })
    expect(state?.commands).toEqual([edited, SECOND])
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

  it('rolls back the latest optimistic mutation when persistence fails', async () => {
    const client = {
      sendRequest: vi
        .fn()
        .mockResolvedValueOnce(success([FIRST]))
        .mockResolvedValueOnce(failure('save failed'))
    } as unknown as RpcClient
    await mount(client)

    await act(async () => {
      await state!.persist({ type: 'delete', id: FIRST.id })
    })

    expect(state?.commands).toEqual([FIRST])
    expect(state?.error).toBe('save failed')
  })

  it('rolls back when a successful update has a malformed authoritative list', async () => {
    const client = {
      sendRequest: vi
        .fn()
        .mockResolvedValueOnce(success([FIRST]))
        .mockResolvedValueOnce({ ok: true, result: {} } as RpcResponse)
    } as unknown as RpcClient
    await mount(client)

    let persisted = true
    await act(async () => {
      persisted = await state!.persist({ type: 'delete', id: FIRST.id })
    })

    expect(persisted).toBe(false)
    expect(state?.commands).toEqual([FIRST])
    expect(state?.error).toBe('Failed to save quick command')
  })

  it('waits for an in-flight save before reloading after reopen', async () => {
    const update = deferred<RpcResponse>()
    let loadCount = 0
    const client = {
      sendRequest: vi.fn((method: string) => {
        if (method === 'settings.updateTerminalQuickCommands') {
          return update.promise
        }
        loadCount += 1
        return Promise.resolve(success(loadCount === 1 ? [FIRST] : []))
      })
    } as unknown as RpcClient

    function Harness({ enabled }: { enabled: boolean }): null {
      state = useQuickCommands({ client, enabled })
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness, { enabled: true }))
      await Promise.resolve()
    })

    let persisted: Promise<boolean> = Promise.resolve(false)
    await act(async () => {
      persisted = state!.persist({ type: 'delete', id: FIRST.id })
      await Promise.resolve()
    })
    await act(async () => {
      renderer!.update(createElement(Harness, { enabled: false }))
      await Promise.resolve()
    })
    await act(async () => {
      renderer!.update(createElement(Harness, { enabled: true }))
      await Promise.resolve()
    })
    expect(loadCount).toBe(1)

    await act(async () => {
      update.resolve(success([]))
      await persisted
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(loadCount).toBe(2)
    expect(state?.commands).toEqual([])
    expect(state?.ready).toBe(true)
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
