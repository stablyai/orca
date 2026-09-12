import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { createSshRelayBrowserNetworkRoute } from './ssh-relay-browser-network-route'

function fixture(emitClose = true) {
  const source = new PassThrough({ emitClose })
  const ready = Promise.withResolvers<PassThrough>()
  const opened = {
    tunnel: { open: vi.fn(() => ready.promise), fail: vi.fn() },
    connection: {},
    assertCurrent: vi.fn(),
    assertAdmission: vi.fn(),
    release: vi.fn(async () => {})
  }
  const abort = new AbortController()
  const assertCurrent = vi.fn()
  const releaseInvalidation = vi.fn()
  const route = createSshRelayBrowserNetworkRoute({
    key: 'test',
    opened: opened as unknown as Parameters<typeof createSshRelayBrowserNetworkRoute>[0]['opened'],
    signal: abort.signal,
    assertCurrent,
    releaseInvalidation
  })
  return { route, source, ready, opened, abort, assertCurrent, releaseInvalidation }
}

it('announces connect only after host Opened and binds destination consumption', async () => {
  const f = fixture()
  const settleRead = vi.fn()
  Object.assign(f.source, { settleRead })
  const socket = f.route.connect({ host: 'internal', port: 443 })
  const connected = vi.fn()
  socket.on('connect', connected)
  await Promise.resolve()
  expect(connected).not.toHaveBeenCalled()
  f.ready.resolve(f.source)
  await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce())
  socket.settleRead?.(42)
  expect(settleRead).toHaveBeenCalledExactlyOnceWith(42)
  socket.destroy()
  await f.route.close()
})

it('releases through the captured cohort without failing or destroying an admitted socket', async () => {
  const f = fixture()
  const socket = f.route.connect({ host: 'internal', port: 443 })
  f.ready.resolve(f.source)
  await Promise.resolve()
  const draining = Promise.withResolvers<void>()
  f.opened.release.mockReturnValueOnce(draining.promise)
  const close = f.route.close()
  expect(f.route.close()).toBe(close)
  expect(f.route.isValid()).toBe(false)
  expect(f.source.destroyed).toBe(false)
  expect(f.opened.tunnel.fail).not.toHaveBeenCalled()
  expect(f.opened.release).toHaveBeenCalledOnce()
  expect(f.releaseInvalidation).not.toHaveBeenCalled()
  draining.resolve()
  socket.destroy()
  await close
  expect(f.releaseInvalidation).toHaveBeenCalledOnce()
})

it('retains pending opens and raw sources after the captured tunnel release resolves', async () => {
  const f = fixture(false)
  const socket = f.route.connect({ host: 'internal', port: 443 })
  const connected = vi.fn()
  socket.on('connect', connected)
  const settled = vi.fn()
  const close = f.route.close()
  void Promise.resolve(close).then(settled)
  await Promise.resolve()
  expect(f.opened.release).toHaveBeenCalledOnce()
  expect(settled).not.toHaveBeenCalled()
  expect(f.releaseInvalidation).not.toHaveBeenCalled()
  f.ready.resolve(f.source)
  await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce())
  expect(settled).not.toHaveBeenCalled()
  socket.destroy()
  await vi.waitFor(() => expect(f.source.destroyed).toBe(true))
  expect(settled).not.toHaveBeenCalled()
  expect(f.releaseInvalidation).not.toHaveBeenCalled()
  f.source.emit('close')
  await close
  expect(f.releaseInvalidation).toHaveBeenCalledOnce()
})

it('does not treat a canceled wrapper or destroyed late source as raw closure', async () => {
  const f = fixture(false)
  const socket = f.route.connect({ host: 'internal', port: 443 })
  socket.destroy()
  const settled = vi.fn()
  const close = f.route.close()
  void Promise.resolve(close).then(settled)
  f.ready.resolve(f.source)
  await vi.waitFor(() => expect(f.source.destroyed).toBe(true))
  expect(settled).not.toHaveBeenCalled()
  expect(f.releaseInvalidation).not.toHaveBeenCalled()
  f.source.emit('close')
  await close
  expect(f.releaseInvalidation).toHaveBeenCalledOnce()
})

it('still waits for captured tunnel release after local sources close', async () => {
  const f = fixture(false)
  const socket = f.route.connect({ host: 'internal', port: 443 })
  const connected = vi.fn()
  socket.on('connect', connected)
  f.ready.resolve(f.source)
  await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce())
  const draining = Promise.withResolvers<void>()
  f.opened.release.mockReturnValueOnce(draining.promise)
  const close = f.route.close()
  socket.destroy()
  f.source.emit('close')
  await Promise.resolve()
  expect(f.releaseInvalidation).not.toHaveBeenCalled()
  draining.resolve()
  await close
  expect(f.releaseInvalidation).toHaveBeenCalledOnce()
})

it('waits for tunnel cleanup after open rejection and retains release failure', async () => {
  const f = fixture()
  const socket = f.route.connect({ host: 'internal', port: 443 })
  const error = vi.fn()
  socket.on('error', error)
  const draining = Promise.withResolvers<void>()
  f.opened.release.mockReturnValueOnce(draining.promise)
  const close = f.route.close()
  const settled = vi.fn()
  void Promise.resolve(close).then(settled, settled)
  const rejection = expect(close).rejects.toThrow('tunnel closure unconfirmed')
  f.ready.reject(new Error('open rejected'))
  await vi.waitFor(() => expect(error).toHaveBeenCalledOnce())
  expect(settled).not.toHaveBeenCalled()
  expect(f.releaseInvalidation).not.toHaveBeenCalled()
  draining.reject(new Error('tunnel closure unconfirmed'))
  await rejection
  expect(f.route.close()).toBe(close)
  expect(f.releaseInvalidation).not.toHaveBeenCalled()
  expect(f.opened.release).toHaveBeenCalledOnce()
})

it('retains raw source failure even if the source later emits close', async () => {
  const f = fixture(false)
  const socket = f.route.connect({ host: 'internal', port: 443 })
  socket.on('error', vi.fn())
  const connected = vi.fn()
  socket.on('connect', connected)
  f.ready.resolve(f.source)
  await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce())
  const close = f.route.close()
  const rejection = expect(close).rejects.toThrow('source closure unconfirmed')
  f.source.emit('error', new Error('source closure unconfirmed'))
  f.source.emit('close')
  await rejection
  expect(f.route.close()).toBe(close)
  expect(f.releaseInvalidation).not.toHaveBeenCalled()
  socket.destroy()
})

it('retains authority evidence and the same rejection when tunnel release fails', async () => {
  const f = fixture()
  f.opened.release.mockRejectedValueOnce(new Error('closure unconfirmed'))
  const closing = f.route.close()
  await expect(closing).rejects.toThrow('closure unconfirmed')
  expect(f.route.close()).toBe(closing)
  expect(f.releaseInvalidation).not.toHaveBeenCalled()
  expect(f.opened.release).toHaveBeenCalledOnce()
})

it('lets a previously admitted open attach while route release is draining', async () => {
  const f = fixture()
  const socket = f.route.connect({ host: 'internal', port: 443 })
  const connected = vi.fn()
  socket.on('connect', connected)
  const close = f.route.close()
  f.ready.resolve(f.source)
  await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce())
  expect(f.source.destroyed).toBe(false)
  socket.destroy()
  await close
})

it('does not invalidate admitted traffic when reset only closes admission', async () => {
  const f = fixture()
  f.opened.assertAdmission.mockImplementation(() => {
    throw new Error('admission closed')
  })
  const socket = f.route.connect({ host: 'internal', port: 443 })
  const error = vi.fn()
  socket.on('error', error)
  await Promise.resolve()
  expect(error).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ message: 'admission closed' })
  )
  expect(f.route.isValid()).toBe(true)
  expect(f.opened.tunnel.open).not.toHaveBeenCalled()
  expect(f.opened.tunnel.fail).not.toHaveBeenCalled()
  await f.route.close()
})

it('retains tunnel failure on authority invalidation and destroys a stale late socket', async () => {
  const f = fixture()
  const socket = f.route.connect({ host: 'internal', port: 443 })
  socket.on('error', vi.fn())
  f.abort.abort()
  await f.route.whenInvalidated
  expect(f.opened.tunnel.fail).toHaveBeenCalledOnce()
  f.ready.resolve(f.source)
  await Promise.resolve()
  expect(f.source.destroyed).toBe(true)
  expect(f.route.isValid()).toBe(false)
  await f.route.close()
})

it('destroys a late host socket after individual browser cancellation', async () => {
  const f = fixture()
  const socket = f.route.connect({ host: 'internal', port: 443 })
  socket.destroy()
  f.ready.resolve(f.source)
  await Promise.resolve()
  expect(f.source.destroyed).toBe(true)
  expect(f.opened.tunnel.fail).not.toHaveBeenCalled()
  await f.route.close()
})

it('retains unconfirmed late-source destruction instead of hanging silently', async () => {
  const f = fixture()
  const socket = f.route.connect({ host: 'internal', port: 443 })
  socket.on('error', vi.fn())
  f.abort.abort()
  vi.spyOn(f.source, 'destroy').mockImplementation(() => {
    throw new Error('source destruction unconfirmed')
  })
  const closing = f.route.close()
  f.ready.resolve(f.source)
  await expect(closing).rejects.toThrow('source destruction unconfirmed')
  expect(f.releaseInvalidation).not.toHaveBeenCalled()
})
