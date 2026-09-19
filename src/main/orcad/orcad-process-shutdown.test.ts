import process from 'node:process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installOrcadStopRequestListener } from './orcad-stop-request-listener'
import { installOrcadProcessShutdown } from './orcad-process-shutdown'

vi.mock('./orcad-stop-request-listener', () => ({ installOrcadStopRequestListener: vi.fn() }))

const context = {
  version: '1.0.0',
  identity: { runtimeId: 'runtime', profileId: 'profile', profileRoot: '/profile' },
  instance: { pid: 123, startedAtMs: null, nonce: 'instance', lockPath: '/data/orcad.lock' }
}
let callbacks: (() => void)[]
let closes: ReturnType<typeof vi.fn>[]
beforeEach(() => {
  callbacks = []
  closes = []
  vi.useFakeTimers()
  vi.spyOn(process, 'on').mockImplementation(() => process)
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(installOrcadStopRequestListener)
    .mockReset()
    .mockImplementation((callback) => {
      callbacks.push(callback)
      const close = vi.fn()
      closes.push(close)
      return { close }
    })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('installs the bound receiver alongside the existing process-only restart receiver', () => {
  installOrcadProcessShutdown({ stop: vi.fn() }, '/slot', context)
  expect(installOrcadStopRequestListener).toHaveBeenNthCalledWith(1, expect.any(Function), {
    installRoot: '/slot',
    managedStop: context
  })
  expect(installOrcadStopRequestListener).toHaveBeenNthCalledWith(2, expect.any(Function), {
    installRoot: '/slot'
  })
})

it('awaits one teardown despite duplicate requests on either listener', async () => {
  let finish = () => {}
  const stop = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  installOrcadProcessShutdown({ stop }, '/slot', context)
  callbacks[0]!()
  callbacks[1]!()
  callbacks[0]!()
  expect(stop).toHaveBeenCalledOnce()
  expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true)
  expect(process.exit).not.toHaveBeenCalled()
  finish()
  await Promise.resolve()
  expect(process.exit).toHaveBeenCalledExactlyOnceWith(0)
})

it('closes a synchronously consumed startup listener without installing another', () => {
  const close = vi.fn()
  vi.mocked(installOrcadStopRequestListener).mockImplementation((callback) => {
    callback()
    return { close }
  })
  installOrcadProcessShutdown({ stop: () => new Promise(() => {}) }, '/slot', context)
  expect(close).toHaveBeenCalledOnce()
  expect(installOrcadStopRequestListener).toHaveBeenCalledOnce()
})

it('keeps failure exit behavior when teardown rejects', async () => {
  installOrcadProcessShutdown(
    {
      stop: async () => {
        throw new Error('teardown')
      }
    },
    '/slot',
    context
  )
  callbacks[0]!()
  await Promise.resolve()
  await Promise.resolve()
  expect(process.exit).toHaveBeenCalledExactlyOnceWith(1)
})
