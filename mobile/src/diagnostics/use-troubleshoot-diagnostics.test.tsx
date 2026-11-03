import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as HostReachability from './host-reachability'

const hosts = vi.hoisted(() => ({
  catalog: vi.fn<() => Promise<{ endpoint: string }[]>>(),
  profiles: vi.fn<() => Promise<{ name: string; endpoint: string }[]>>()
}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios', Version: '27' } }))
vi.mock('../transport/host-store', () => ({
  loadHostCatalog: hosts.catalog,
  loadHosts: hosts.profiles
}))
vi.mock('./host-reachability', async (importOriginal) => ({
  ...(await importOriginal<typeof HostReachability>()),
  testHostReachability: async () => true
}))

import { useTroubleshootDiagnostics } from './use-troubleshoot-diagnostics'

let tree: ReactTestRenderer | undefined
const state: { current: ReturnType<typeof useTroubleshootDiagnostics> | null } = { current: null }
function Harness() {
  state.current = useTroubleshootDiagnostics()
  return null
}

afterEach(async () => {
  await act(async () => tree?.unmount())
  state.current = null
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

describe('troubleshooting paired endpoints', () => {
  it('loads endpoint advice before the user runs diagnostics', async () => {
    hosts.catalog.mockResolvedValue([{ endpoint: 'ws://desktop.local:6769' }])
    await act(async () => {
      tree = create(createElement(Harness))
    })
    expect(state.current?.diagnosticStatus).toBe('idle')
    expect(state.current?.hostEndpoints).toEqual(['ws://desktop.local:6769'])
  })

  it('keeps the newly probed endpoints when the initial catalog read finishes later', async () => {
    let finishCatalog: (value: { endpoint: string }[]) => void = () => {}
    hosts.catalog
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishCatalog = resolve
        })
      )
      .mockResolvedValue([{ endpoint: 'ws://desktop.local:7777' }])
    hosts.profiles.mockResolvedValue([{ name: 'Desktop', endpoint: 'ws://desktop.local:7777' }])
    vi.stubGlobal('fetch', async () => ({ ok: true }))
    await act(async () => {
      tree = create(createElement(Harness))
    })
    await act(async () => {
      await state.current?.runDiagnostics()
    })
    await act(async () => {
      finishCatalog([{ endpoint: 'ws://desktop.local:6769' }])
    })
    expect(state.current?.hostEndpoints).toEqual(['ws://desktop.local:7777'])
    expect(state.current?.checks).toContainEqual({
      label: 'Desktop',
      status: 'pass',
      detail: 'Reachable at desktop.local:7777'
    })
  })

  it('retains saved port advice after a run when the host credential is unavailable', async () => {
    hosts.catalog.mockResolvedValue([{ endpoint: 'ws://desktop.local:6769' }])
    hosts.profiles.mockResolvedValue([])
    vi.stubGlobal('fetch', async () => ({ ok: true }))
    await act(async () => {
      tree = create(createElement(Harness))
    })
    expect(state.current?.hostEndpoints).toEqual(['ws://desktop.local:6769'])
    await act(async () => {
      await state.current?.runDiagnostics()
    })
    expect(state.current?.hostEndpoints).toEqual(['ws://desktop.local:6769'])
  })
})
