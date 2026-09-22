import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { RelayContext } from './context'
import type { RelayDispatcher } from './dispatcher'
import { FsHandler } from './fs-handler'
import { subscribeWithInProcessWatcher } from '../main/ipc/parcel-watcher-in-process-fallback'
import { createMockDispatcher } from './relay-fs-test-dispatcher'

const { mockSubscribe } = vi.hoisted(() => ({
  mockSubscribe: vi.fn()
}))

vi.mock('@parcel/watcher', () => ({
  subscribe: mockSubscribe
}))

describe('relay watch-root capacity', () => {
  let dispatcher: ReturnType<typeof createMockDispatcher>
  let handler: FsHandler
  let tmpDir: string

  beforeEach(() => {
    mockSubscribe.mockReset()
    mockSubscribe.mockResolvedValue({ unsubscribe: vi.fn() })
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-fs-cap-'))
    dispatcher = createMockDispatcher()
    handler = new FsHandler(dispatcher as unknown as RelayDispatcher, new RelayContext(), {
      dispose: vi.fn(),
      forgetRoot: vi.fn(),
      subscribe: subscribeWithInProcessWatcher
    })
  })

  afterEach(async () => {
    handler.dispose()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('blocks replacement watches behind physical unsubscribe and counts the pending slot', async () => {
    let resolveUnsubscribe: () => void = () => {}
    const unsubscribe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUnsubscribe = resolve
        })
    )
    mockSubscribe.mockResolvedValue({ unsubscribe })
    await dispatcher.callRequest('fs.watch', { rootPath: tmpDir })
    dispatcher.callNotification('fs.unwatch', { rootPath: tmpDir })

    const replacement = dispatcher.callRequest('fs.watch', { rootPath: tmpDir })
    for (let index = 0; index < 19; index += 1) {
      await dispatcher.callRequest('fs.watch', {
        rootPath: path.join(tmpDir, `pending-cap-${index}`)
      })
    }
    // The replacement claims the slot the teardown releases, so this cap is genuinely full: the
    // request waits for the release event and is still refused once it has happened.
    const overCap = dispatcher
      .callRequest('fs.watch', { rootPath: path.join(tmpDir, 'over-pending-cap') })
      .then(
        () => null,
        (error: Error) => error
      )
    expect(mockSubscribe).toHaveBeenCalledTimes(20)

    resolveUnsubscribe()
    await replacement
    expect(await overCap).toMatchObject({ message: 'Maximum number of file watchers reached' })
    expect(mockSubscribe).toHaveBeenCalledTimes(21)
  })

  it('waits out a teardown that frees a slot instead of refusing on it', async () => {
    let resolveUnsubscribe: () => void = () => {}
    mockSubscribe.mockResolvedValue({
      unsubscribe: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveUnsubscribe = resolve
          })
      )
    })
    for (let index = 0; index < 20; index += 1) {
      await dispatcher.callRequest('fs.watch', { rootPath: path.join(tmpDir, `full-${index}`) })
    }
    dispatcher.callNotification('fs.unwatch', { rootPath: path.join(tmpDir, 'full-0') })

    // Why not a refusal: the slot is already promised back, and the client answers a capacity
    // refusal with a 60s-to-30min dormancy that no release event can shorten.
    let settled = false
    const fresh = dispatcher
      .callRequest('fs.watch', { rootPath: path.join(tmpDir, 'fresh') })
      .then(() => {
        settled = true
      })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(mockSubscribe).toHaveBeenCalledTimes(20)

    resolveUnsubscribe()
    await fresh
    expect(mockSubscribe).toHaveBeenCalledTimes(21)
  })
})
