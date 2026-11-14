import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const state = vi.hoisted(() => ({
  contents: new Map(),
  metrics: [{ pid: 50, creationTime: 100 }],
  records: new Array<unknown>(),
  publication: Promise.resolve()
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: Object.assign(new EventEmitter(), { getAppMetrics: () => state.metrics }),
    webContents: { fromId: (id: number) => state.contents.get(id) }
  }
})
vi.mock('../observability', () => ({
  resolveObservabilityConsent: () => ({ localFileEnabled: true })
}))
vi.mock('../persistence/loading-store/user-data-path', () => ({
  getCanonicalUserDataPath: () => '/qa'
}))
vi.mock('./renderer-hang-records', () => ({
  publishRendererHang: (_path: string, record: unknown) => {
    state.records.push(structuredClone(record))
    return state.publication
  }
}))
import { startRendererHangCapture } from './renderer-hang-capture'

const handles: { stop: () => void }[] = []
const responses: (() => void)[] = []
beforeEach(() => {
  state.contents.clear()
  state.records = []
  state.publication = Promise.resolve()
  state.metrics = [{ pid: 50, creationTime: 100 }]
  vi.useFakeTimers()
  vi.setSystemTime(1000)
})
afterEach(async () => {
  for (const handle of handles.splice(0)) {
    handle.stop()
  }
  for (const respond of responses.splice(0)) {
    respond()
  }
  await Promise.resolve()
  vi.clearAllTimers()
  vi.useRealTimers()
})
function window(id: number, pid = 50) {
  let reply: (stack: string) => void = () => {}
  let requested = false
  const frame = {
    processId: 7,
    osProcessId: pid,
    collectJavaScriptCallStack: () => {
      requested = true
      return new Promise<string>((resolve) => {
        reply = resolve
        responses.push(() => resolve(''))
      })
    }
  }
  const contents = { id, mainFrame: frame, isDestroyed: () => false, isDevToolsOpened: () => false }
  state.contents.set(id, contents)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this Electron test double supplies the members used by the collector; unused native members are never accessed.
  const target = { id, webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow
  return {
    requested: () => requested,
    start: async () => {
      const handle = startRendererHangCapture(target)
      if (handle) {
        handles.push(handle)
      }
      await Promise.resolve()
      return handle
    },
    reply: async () => {
      reply('at busy (file:///private/qa/app.js:7:3)')
      await Promise.resolve()
      await Promise.resolve()
    }
  }
}

it('keeps a shared-process request owned across window death and drops its stale result', async () => {
  const old = window(1)
  ;(await old.start())?.stop()
  state.contents.delete(1)
  const replacement = window(2)
  await replacement.start()
  expect(state.records.at(-1)).toMatchObject({
    windowId: 2,
    status: 'process-capture-pending',
    stacks: []
  })
  await old.reply()
  expect(
    state.records.some(
      (record) =>
        record !== null &&
        typeof record === 'object' &&
        'status' in record &&
        record.status === 'captured'
    )
  ).toBe(false)
  vi.setSystemTime(2000)
  await replacement.start()
  await replacement.reply()
  expect(state.records.at(-1)).toMatchObject({
    windowId: 2,
    status: 'captured',
    stacks: [{ frames: [{ name: 'busy', module: 'app.js', line: 7, column: 3 }], count: 1 }]
  })
})

it('reconciles a dead generation before admission and an old reply cannot clear its successor', async () => {
  const old = window(3)
  ;(await old.start())?.stop()
  state.contents.delete(3)
  state.metrics = [{ pid: 50, creationTime: 200 }]
  const successor = window(4)
  await successor.start()
  await old.reply()
  const shared = window(5)
  await shared.start()
  expect(state.records.at(-1)).toMatchObject({ windowId: 5, status: 'process-capture-pending' })
  await successor.reply()
  expect(state.records.at(-1)).toMatchObject({ windowId: 4, status: 'captured' })
})

it('awaits baseline publication before requesting a stack and cannot start after cancellation during the write', async () => {
  let finishPublication: () => void = () => {}
  state.publication = new Promise<void>((resolve) => {
    finishPublication = resolve
  })
  const cancelled = window(8)
  const handle = await cancelled.start()
  expect(cancelled.requested()).toBe(false)
  handle?.stop()
  finishPublication()
  await Promise.resolve()
  expect(cancelled.requested()).toBe(false)

  state.publication = new Promise<void>((resolve) => {
    finishPublication = resolve
  })
  const live = window(9)
  await live.start()
  expect(live.requested()).toBe(false)
  finishPublication()
  await Promise.resolve()
  expect(live.requested()).toBe(true)
  await live.reply()
  expect(state.records.at(-1)).toMatchObject({ windowId: 9, status: 'captured' })
})
