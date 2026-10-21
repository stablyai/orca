import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { appStateListeners, listRequest, wakeRequest } = vi.hoisted(() => ({
  appStateListeners: new Array<(state: string) => void>(),
  listRequest: vi.fn(),
  wakeRequest: vi.fn()
}))

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appStateListeners.push(listener)
      return { remove: () => appStateListeners.splice(appStateListeners.indexOf(listener), 1) }
    }
  }
}))
vi.mock('./machine-operations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./machine-operations')>()
  return {
    ...actual,
    machinesListRead: { ...actual.machinesListRead, request: listRequest },
    machineWake: { ...actual.machineWake, request: wakeRequest }
  }
})

import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { useHostMachines, useHostMachinesAvailable } from './use-host-machines'

const KEY = 'plugin:acme.omarchy/omarchy'
const meta = { runtimeId: 'r' }
const providers = [
  {
    providerKey: KEY,
    name: 'Omarchy box',
    machines: [
      { id: 'sbx-1', name: 'dev', lifetime: 'persistent', state: 'sleeping', lastSeenAt: 1 }
    ],
    pendingCreates: []
  }
]
const listed = { id: 'l', ok: true, result: { ok: true, value: providers }, _meta: meta }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook only hands the client to the mocked operations.
const CLIENT = {} as RpcClient

afterEach(() => {
  listRequest.mockReset()
  wakeRequest.mockReset()
  appStateListeners.length = 0
})

function renderMachines() {
  const result: { current: ReturnType<typeof useHostMachines> | null } = { current: null }
  function Harness() {
    result.current = useHostMachines({
      client: CLIENT,
      connState: 'connected',
      focused: true,
      now: () => 1_000
    })
    return null
  }
  act(() => {
    create(createElement(Harness))
  })
  return result
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('useHostMachines', () => {
  it('asks providers on open, but a poll and failed read keep the rows marked stale', async () => {
    listRequest.mockResolvedValueOnce(listed).mockRejectedValueOnce(new Error('socket closed'))
    const machines = renderMachines()
    await settle()
    expect(listRequest).toHaveBeenLastCalledWith(CLIENT, { refresh: true })
    expect(machines.current?.state).toMatchObject({ status: 'ready', error: null })

    await act(async () => {
      await machines.current?.refresh()
    })
    expect(machines.current?.state).toMatchObject({
      status: 'ready',
      fetchedAt: 1_000,
      error: 'socket closed',
      providers: [{ machines: [{ id: 'sbx-1' }] }]
    })
  })

  it('polls the cached list without asking providers', async () => {
    vi.useFakeTimers()
    try {
      listRequest.mockResolvedValue(listed)
      renderMachines()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(listRequest).toHaveBeenLastCalledWith(CLIENT, { refresh: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads a lost connection during wake as unverified and re-checks, never as a refusal', async () => {
    listRequest.mockResolvedValue(listed)
    wakeRequest.mockRejectedValueOnce(new Error('relay dropped'))
    const machines = renderMachines()
    await settle()
    const listsBefore = listRequest.mock.calls.length
    await act(async () => {
      await machines.current?.act(KEY, 'sbx-1', 'wake')
    })
    expect(machines.current?.notice).toMatchObject({ title: 'Lost contact' })
    expect(listRequest.mock.calls.length).toBe(listsBefore + 1)
    expect(machines.current?.busy).toBeNull()
  })

  it('shows a provider refusal as one', async () => {
    listRequest.mockResolvedValue(listed)
    wakeRequest.mockResolvedValueOnce({
      id: 'w',
      ok: true,
      result: { ok: false, code: 'quota', message: 'Out of credits' },
      _meta: meta
    })
    const machines = renderMachines()
    await settle()
    await act(async () => {
      await machines.current?.act(KEY, 'sbx-1', 'wake')
    })
    expect(machines.current?.notice).toEqual({
      title: 'Could not wake machine',
      message: 'Out of credits'
    })
  })
})

describe('useHostMachinesAvailable', () => {
  it('resets when the connection drops and re-checks when the app returns', async () => {
    listRequest.mockResolvedValue(listed)
    const result: { current: boolean } = { current: false }
    function Harness({ connState }: { connState: ConnectionState }) {
      result.current = useHostMachinesAvailable(CLIENT, connState)
      return null
    }
    let renderer: ReturnType<typeof create> | null = null
    act(() => {
      renderer = create(createElement(Harness, { connState: 'connected' }))
    })
    await settle()
    expect(result.current).toBe(true)

    act(() => renderer!.update(createElement(Harness, { connState: 'reconnecting' })))
    expect(result.current).toBe(false)

    listRequest.mockResolvedValue({
      id: 'l',
      ok: true,
      result: { ok: true, value: [] },
      _meta: meta
    })
    act(() => renderer!.update(createElement(Harness, { connState: 'connected' })))
    await settle()
    expect(result.current).toBe(false)
    listRequest.mockResolvedValue(listed)
    await act(async () => {
      for (const listener of appStateListeners) {
        listener('active')
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(result.current).toBe(true)
  })
})
