import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const state = vi.hoisted(() => ({
  contents: new Map(),
  metrics: [{ pid: 50, creationTime: 100 }],
  records: new Array<unknown>()
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
  publishRendererHang: (_path: string, record: unknown) =>
    state.records.push(structuredClone(record))
}))
import { startRendererHangCapture, reduceRendererHangStack } from './renderer-hang-capture'

const handles: { stop: () => void }[] = []
beforeEach(() => {
  state.contents.clear()
  state.records = []
  state.metrics = [{ pid: 50, creationTime: 100 }]
  vi.useFakeTimers()
  vi.setSystemTime(1000)
})
afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.stop()
  }
  vi.clearAllTimers()
  vi.useRealTimers()
})
function window(id: number, pid = 50) {
  let reply: (stack: string) => void = () => {}
  const frame = {
    processId: 7,
    osProcessId: pid,
    collectJavaScriptCallStack: () =>
      new Promise<string>((resolve) => {
        reply = resolve
      })
  }
  const contents = { id, mainFrame: frame, isDestroyed: () => false, isDevToolsOpened: () => false }
  state.contents.set(id, contents)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this Electron test double supplies the members used by the collector; unused native members are never accessed.
  const target = { id, webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow
  return {
    start: () => {
      const handle = startRendererHangCapture(target)
      if (handle) {
        handles.push(handle)
      }
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
  old.start()?.stop()
  state.contents.delete(1)
  const replacement = window(2)
  replacement.start()
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
  replacement.start()
  await replacement.reply()
  expect(state.records.at(-1)).toMatchObject({
    windowId: 2,
    status: 'captured',
    stacks: [{ frames: [{ name: 'busy', module: 'app.js', line: 7, column: 3 }], count: 1 }]
  })
})

it('reconciles a dead generation before admission and an old reply cannot clear its successor', async () => {
  const old = window(3)
  old.start()?.stop()
  state.contents.delete(3)
  state.metrics = [{ pid: 50, creationTime: 200 }]
  const successor = window(4)
  successor.start()
  await old.reply()
  const shared = window(5)
  shared.start()
  expect(state.records.at(-1)).toMatchObject({ windowId: 5, status: 'process-capture-pending' })
  await successor.reply()
  expect(state.records.at(-1)).toMatchObject({ windowId: 4, status: 'captured' })
})

it('drops a cut input field before redaction while preserving complete frames', () => {
  const result = reduceRendererHangStack(
    `at busy (file:///private/home/app.js:7:3)\n${'at '.repeat(6000)}`
  )
  expect(result).toEqual({
    frames: [{ name: 'busy', module: 'app.js', line: 7, column: 3 }],
    status: 'captured',
    truncated: true
  })
})

it('records an unanswered renderer request explicitly while retaining its physical owner', () => {
  const blocked = window(6)
  blocked.start()?.stop()
  expect(state.records.at(-1)).toMatchObject({ windowId: 6, status: 'request-pending', samples: 0 })
  const shared = window(7)
  shared.start()
  expect(state.records.at(-1)).toMatchObject({ windowId: 7, status: 'process-capture-pending' })
})
