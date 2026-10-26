import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTroubleshootDiagnostics } from './use-troubleshoot-diagnostics'
import { noteEndpointAuthHeadersChanged } from '../transport/endpoint-auth-headers'
import { markHostCredentialWrite } from '../transport/host-credential-write-revision'

const dependencies = vi.hoisted(() => ({ loadHosts: vi.fn(), prime: vi.fn(), probe: vi.fn() }))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('../transport/host-store', () => ({ loadHosts: dependencies.loadHosts }))
vi.mock('../transport/endpoint-auth-headers-store', () => ({
  primeEndpointAuthHeaders: dependencies.prime
}))
vi.mock('./host-reachability', () => ({
  testHostReachability: dependencies.probe,
  formatEndpoint: () => 'orca.example',
  unreachableHostDetail: () => 'Cannot reach orca.example'
}))
const headers = { 'X-Token': 'synthetic-secret' }
const host = { id: 'host-1', name: 'test', endpoint: 'wss://orca.example' }
let renderer: ReactTestRenderer | undefined
let diagnostics: ReturnType<typeof useTroubleshootDiagnostics> | undefined
function Harness() {
  diagnostics = useTroubleshootDiagnostics()
  return null
}
beforeEach(() => {
  dependencies.loadHosts.mockReset().mockResolvedValue([host])
  dependencies.prime.mockReset().mockResolvedValue(headers)
  dependencies.probe.mockReset().mockResolvedValue(true)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
})
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  diagnostics = undefined
  vi.unstubAllGlobals()
})
it('loads origin-bound credentials before checking a paired tunnel host', async () => {
  await act(async () => {
    renderer = create(createElement(Harness))
  })
  await act(async () => {
    await diagnostics?.runDiagnostics()
  })
  expect(dependencies.prime).toHaveBeenCalledWith(host.id, host.endpoint, expect.any(Function))
  expect(dependencies.probe).toHaveBeenCalledWith(host.endpoint, headers)
  expect(diagnostics?.checks.find((check) => check.label === host.name)?.status).toBe('pass')
})
it('does not start a probe after leaving while credentials are loading', async () => {
  let finishRead: (value: typeof headers) => void = () => {}
  dependencies.prime.mockReturnValueOnce(new Promise((resolve) => (finishRead = resolve)))
  await act(async () => {
    renderer = create(createElement(Harness))
  })
  let running: Promise<void> | undefined
  await act(async () => {
    running = diagnostics?.runDiagnostics()
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(dependencies.prime).toHaveBeenCalledOnce()
  act(() => diagnostics?.rootRef(null))
  await act(async () => {
    finishRead(headers)
    await running
  })
  expect(dependencies.probe).not.toHaveBeenCalled()
})

it.each(['clear', 'replace'] as const)(
  'does not use a credential read overlapping %s',
  async (kind) => {
    let finishRead: (value: typeof headers) => void = () => {}
    dependencies.prime.mockReturnValueOnce(new Promise((resolve) => (finishRead = resolve)))
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    let running: Promise<void> | undefined
    await act(async () => {
      running = diagnostics?.runDiagnostics()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(dependencies.prime).toHaveBeenCalledOnce()
    if (kind === 'clear') {
      noteEndpointAuthHeadersChanged(host.id)
    } else {
      markHostCredentialWrite(host.id)
    }
    await act(async () => {
      finishRead(headers)
      await running
    })
    expect(dependencies.probe).not.toHaveBeenCalled()
  }
)

it.each(['clear', 'replace'] as const)(
  'discards a completed probe overlapping %s',
  async (kind) => {
    let finishProbe: (reachable: boolean) => void = () => {}
    dependencies.probe.mockReturnValueOnce(new Promise((resolve) => (finishProbe = resolve)))
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    let running: Promise<void> | undefined
    await act(async () => {
      running = diagnostics?.runDiagnostics()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(dependencies.probe).toHaveBeenCalledOnce()
    if (kind === 'clear') {
      noteEndpointAuthHeadersChanged(host.id)
    } else {
      markHostCredentialWrite(host.id)
    }
    await act(async () => {
      finishProbe(true)
      await running
    })
    expect(diagnostics?.checks.some((check) => check.label === host.name)).toBe(false)
    expect(diagnostics?.diagnosticStatus).toBe('done')
  }
)
