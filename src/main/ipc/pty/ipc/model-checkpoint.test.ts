import { expect, it, vi } from 'vitest'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { PTY_ID } from '../../../runtime/headless-hydration-ownership-test-fixture'
import { kittyImage } from '../../../runtime/headless-model-checkpoint-test-fixture'
import { makeDeferred } from '../../../runtime/orca-runtime-test-fixtures.spec'
import {
  capture,
  contents,
  incarnationId,
  install,
  invoke,
  ipcEvent,
  mainWindow,
  read
} from './model-checkpoint-test-fixture'

it('captures the real runtime and exposes owned bytes only to the main frame', async () => {
  install()
  const descriptor = await capture()
  expect(descriptor).toMatchObject({
    version: 1,
    ptyId: PTY_ID,
    incarnationId,
    sourceSeq: `FIRST${kittyImage()}`.length
  })
  await expect(read(descriptor.leaseId)).resolves.toEqual(new Uint8Array(['{'.charCodeAt(0)]))
  await expect(
    invoke('releaseModelCheckpoint', { id: PTY_ID, leaseId: descriptor.leaseId })
  ).resolves.toBe(true)
  await expect(read(descriptor.leaseId)).rejects.toThrow('Invalid or expired')
})

it.each(['foreign window', 'subframe', 'missing frame', 'destroyed window', 'destroyed contents'])(
  'declines %s access without releasing a legitimate lease',
  async (kind) => {
    install()
    const descriptor = await capture()
    let event = ipcEvent()
    if (kind === 'foreign window') {
      event = ipcEvent({ mainFrame: {} })
    }
    if (kind === 'subframe') {
      event = ipcEvent(contents, {})
    }
    if (kind === 'missing frame') {
      event = ipcEvent(contents, null)
    }
    if (kind === 'destroyed window') {
      mainWindow.isDestroyed.mockReturnValue(true)
    }
    if (kind === 'destroyed contents') {
      contents.isDestroyed.mockReturnValue(true)
    }
    await expect(
      invoke('captureModelCheckpoint', { id: PTY_ID, expectedIncarnationId: incarnationId }, event)
    ).resolves.toBeNull()
    await expect(read(descriptor.leaseId, event)).rejects.toThrow('Invalid or expired')
    await expect(
      invoke('releaseModelCheckpoint', { id: PTY_ID, leaseId: descriptor.leaseId }, event)
    ).resolves.toBe(false)
    mainWindow.isDestroyed.mockReturnValue(false)
    contents.isDestroyed.mockReturnValue(false)
    await expect(read(descriptor.leaseId)).resolves.toHaveLength(1)
  }
)

it.each(['did-finish-load', 'render-process-gone', 'destroyed'])(
  'retires prior document leases on %s',
  async (event) => {
    install()
    const descriptor = await capture()
    contents.emit(event)
    await expect(read(descriptor.leaseId)).rejects.toThrow('Invalid or expired')
  }
)

it('retires leases on main-frame navigation but preserves subframes and same-document navigation', async () => {
  install()
  const descriptor = await capture()
  for (const details of [
    { isMainFrame: false, isSameDocument: false },
    { isMainFrame: true, isSameDocument: true }
  ]) {
    contents.emit('did-start-navigation', details)
    await expect(read(descriptor.leaseId)).resolves.toHaveLength(1)
  }
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  await expect(read(descriptor.leaseId)).rejects.toThrow('Invalid or expired')
})

it('removes old lifecycle handlers and leases when registration changes owner', async () => {
  install()
  const descriptor = await capture()
  expect(contents.listenerCount('did-finish-load')).toBe(1)
  install()
  expect(contents.listenerCount('did-finish-load')).toBe(1)
  await expect(read(descriptor.leaseId)).rejects.toThrow('Invalid or expired')
})

it.each(['remote', 'unknown', 'stale incarnation'])(
  'does not substitute a local complete model for %s ownership',
  async (kind) => {
    install()
    if (kind === 'remote') {
      ptyOwnership.set(PTY_ID, 'ssh-connection')
    }
    if (kind === 'unknown') {
      ptyOwnership.delete(PTY_ID)
    }
    if (kind === 'stale incarnation') {
      ptyIncarnationById.set(PTY_ID, 'replacement-incarnation')
    }
    await expect(
      invoke('captureModelCheckpoint', { id: PTY_ID, expectedIncarnationId: incarnationId })
    ).resolves.toBeNull()
  }
)

it('releases its runtime exit subscription with the lease', async () => {
  const runtime = install()
  const unsubscribe = vi.fn()
  vi.spyOn(runtime, 'subscribeToPtyExit').mockReturnValueOnce(unsubscribe)
  const descriptor = await capture()
  await invoke('releaseModelCheckpoint', { id: PTY_ID, leaseId: descriptor.leaseId })
  expect(unsubscribe).toHaveBeenCalledOnce()
  await invoke('releaseModelCheckpoint', { id: PTY_ID, leaseId: descriptor.leaseId })
  expect(unsubscribe).toHaveBeenCalledOnce()
})

it('releases leases on the owning runtime exit', async () => {
  const runtime = install()
  const descriptor = await capture()
  runtime.onPtyExit(PTY_ID, 0, incarnationId, { providerExitObserved: true })
  await expect(read(descriptor.leaseId)).rejects.toThrow('Invalid or expired')
})

it('does not publish a capture whose document disappears while ownership settles', async () => {
  const runtime = install()
  await runtime.model().writeChain
  const gate = makeDeferred()
  const started = makeDeferred()
  vi.spyOn(runtime.model().ownership, 'settle').mockImplementationOnce(async () => {
    started.resolve()
    await gate.promise
  })
  const pending = invoke('captureModelCheckpoint', {
    id: PTY_ID,
    expectedIncarnationId: incarnationId
  })
  await started.promise
  contents.emit('render-process-gone')
  gate.resolve()
  await expect(pending).resolves.toBeNull()
})

it('declines a runtime incarnation that disagrees with the provider registry', async () => {
  const runtime = install()
  runtime.acceptPtyIncarnationForExit(PTY_ID, 'retired-runtime-incarnation')
  await expect(
    invoke('captureModelCheckpoint', {
      id: PTY_ID,
      expectedIncarnationId: incarnationId
    })
  ).resolves.toBeNull()
})

it.each(['incarnation', 'execution host'])(
  'releases an unpublished capture when its %s changes during preparation',
  async (kind) => {
    const runtime = install()
    await runtime.model().writeChain
    const gate = makeDeferred()
    const started = makeDeferred()
    const unsubscribe = vi.fn()
    vi.spyOn(runtime, 'subscribeToPtyExit').mockReturnValueOnce(unsubscribe)
    vi.spyOn(runtime.model().ownership, 'settle').mockImplementationOnce(async () => {
      started.resolve()
      await gate.promise
    })
    const pending = invoke('captureModelCheckpoint', {
      id: PTY_ID,
      expectedIncarnationId: incarnationId
    })
    await started.promise
    if (kind === 'incarnation') {
      ptyIncarnationById.set(PTY_ID, 'replacement-incarnation')
    } else {
      ptyOwnership.set(PTY_ID, 'ssh-replacement')
    }
    gate.resolve()
    await expect(pending).resolves.toBeNull()
    expect(unsubscribe).toHaveBeenCalledOnce()
  }
)

it.each([
  { id: PTY_ID },
  { id: PTY_ID, expectedIncarnationId: incarnationId, viewerId: 'injected' }
])('declines malformed capture authority %j', async (request) => {
  install()
  await expect(invoke('captureModelCheckpoint', request)).resolves.toBeNull()
})

it('rejects invalid windows and paths without retiring the legitimate lease', async () => {
  install()
  const descriptor = await capture()
  const request = {
    id: PTY_ID,
    leaseId: descriptor.leaseId,
    resourceId: null,
    offset: 0,
    length: 1
  }
  for (const change of [
    { resourceId: '/tmp/image.png' },
    { length: 262145 },
    { viewerId: 'injected' },
    { offset: -1 }
  ]) {
    await expect(invoke('readModelCheckpoint', { ...request, ...change })).rejects.toThrow()
  }
  await expect(
    invoke('releaseModelCheckpoint', { id: PTY_ID, leaseId: 'not-a-lease' })
  ).resolves.toBe(false)
  await expect(read(descriptor.leaseId)).resolves.toHaveLength(1)
})
