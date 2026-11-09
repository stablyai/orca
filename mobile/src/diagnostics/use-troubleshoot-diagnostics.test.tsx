import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as HostReachability from './host-reachability'

const hosts = vi.hoisted(() => ({
  catalog: vi.fn<() => Promise<{ endpoint: string }[]>>(),
  profiles: vi.fn<() => Promise<{ name: string; endpoint: string }[]>>()
}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios', Version: '27' } }))
vi.mock('../transport/hosts/host-store', () => ({
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
