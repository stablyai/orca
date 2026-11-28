import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { SESSION_TAB_CLOSE_TIMEOUT_ERROR } from '../../../shared/workspace-layout/client-views/session-tab-close'

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  return { ipcMain: new Emitter() }
})

import { requestSessionTabCloseFromRenderer } from './session-tab-close-request-relay'

afterEach(() => {
  vi.useRealTimers()
})

/** A window that takes each request and never answers. */
function silentWindow() {
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: () => {}
  })
  return Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents })
}

// A drop asks no one, so a window that never answers must not hold the client's close for the
// minutes a person gets to confirm one.
it('gives up on an unanswered drop within seconds', async () => {
  vi.useFakeTimers()
  const drop = requestSessionTabCloseFromRenderer(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the relay uses only isDestroyed, webContents and window events.
    silentWindow() as never,
    'agent-session:chat',
    'wt',
    'drop'
  )
  const settled = drop.then(
    () => 'answered',
    (error: Error) => error.message
  )
  await vi.advanceTimersByTimeAsync(10_000)
  expect(await Promise.race([settled, Promise.resolve('waiting')])).toBe(
    SESSION_TAB_CLOSE_TIMEOUT_ERROR
  )
})
