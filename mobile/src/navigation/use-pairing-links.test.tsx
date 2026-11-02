import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, expect, it, vi } from 'vitest'

const links = vi.hoisted(() => ({
  initial: vi.fn<() => Promise<string | null>>(),
  replace: vi.fn(),
  listeners: new Set<(event: { url: string }) => void>()
}))
const router = { replace: links.replace }
vi.mock('expo-router', () => ({ useRouter: () => router }))
vi.mock('expo-linking', () => ({
  getInitialURL: links.initial,
  addEventListener: (_type: string, listener: (event: { url: string }) => void) => {
    links.listeners.add(listener)
    return { remove: () => links.listeners.delete(listener) }
  }
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  links.listeners.clear()
})

async function mountPairingRoot(): Promise<ReactTestRenderer> {
  const { usePairingLinks } = await import('./use-pairing-links')
  function Root() {
    usePairingLinks()
    return null
  }
  const mounted: { tree?: ReactTestRenderer } = {}
  await act(async () => {
    mounted.tree = create(createElement(Root))
  })
  if (!mounted.tree) {
    throw new Error('pairing root did not mount')
  }
  return mounted.tree
}

it('handles a cold link once and keeps warm links working after recovery remount', async () => {
  links.initial.mockResolvedValue('orca://pair?code=cold-code')
  const first = await mountPairingRoot()
  expect(links.replace).toHaveBeenCalledExactlyOnceWith({
    pathname: '/pair-confirm',
    params: { code: 'cold-code' }
  })
  await act(async () => first.unmount())
  expect(links.listeners.size).toBe(0)

  const recovered = await mountPairingRoot()
  expect(links.replace).toHaveBeenCalledTimes(1)
  expect(links.initial).toHaveBeenCalledTimes(1)
  await act(async () => {
    for (const listener of links.listeners) {
      listener({ url: 'orca://pair?code=warm-code' })
    }
  })
  expect(links.replace).toHaveBeenLastCalledWith({
    pathname: '/pair-confirm',
    params: { code: 'warm-code' }
  })
  await act(async () => recovered.unmount())
})

it('does not redirect Home when a pending launch-link read completes after recovery', async () => {
  let resolveUrl: (url: string) => void = () => {}
  links.initial.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveUrl = resolve
      })
  )
  const first = await mountPairingRoot()
  await act(async () => first.unmount())
  const recovered = await mountPairingRoot()
  await act(async () => resolveUrl('orca://pair?code=stale-code'))
  expect(links.replace).not.toHaveBeenCalled()
  await act(async () => recovered.unmount())
})
