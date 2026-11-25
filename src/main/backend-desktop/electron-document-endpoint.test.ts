import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'

vi.mock('../crash-reporting/breadcrumbs/durable-crash-breadcrumb', () => ({
  recordCoalescedDurableCrashBreadcrumb: () => {}
}))

const { electronDocumentEndpoint } = await import('./electron-document-endpoint')

type InvokeSource = Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>

// Models Electron 43: one WebFrameMain re-pointed at each new document, `detached` stuck after a crash.
class FakeMainFrame {
  token: string | null = 'doc-1'
  detached = false
  get frameToken(): string {
    if (this.token === null) {
      throw new Error('Render frame was disposed before WebFrameMain could be accessed')
    }
    return this.token
  }
}

function fakeWindow() {
  const frame = new FakeMainFrame()
  const delivered: unknown[][] = []
  const sender = Object.assign(new EventEmitter(), {
    id: 1,
    mainFrame: frame,
    isDestroyed: () => false,
    isCrashed: () => frame.token === null,
    send: (...args: unknown[]) => {
      delivered.push(args)
    }
  })
  const invokeFrom = (senderFrame: object | null = frame) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the endpoint reads only the members modeled here.
    const event = { sender, senderFrame } as unknown as InvokeSource
    return electronDocumentEndpoint(event)
  }
  return { frame, sender, delivered, invokeFrom }
}

it('admits only the live document across reload, crash and crash reload', () => {
  const { frame, invokeFrom } = fakeWindow()
  const first = invokeFrom()
  expect(first.isCurrent()).toBe(true)

  frame.token = 'doc-2'
  const reloaded = invokeFrom()
  expect(first.isCurrent()).toBe(false)
  expect(reloaded.isCurrent()).toBe(true)

  frame.token = null
  frame.detached = true
  expect(reloaded.isCurrent()).toBe(false)
  expect(invokeFrom().isCurrent()).toBe(false)

  frame.token = 'doc-3'
  const recovered = invokeFrom()
  expect(recovered.isCurrent()).toBe(true)
  expect(first.isCurrent()).toBe(false)
  expect(reloaded.isCurrent()).toBe(false)

  // An old page's unload IPC after a commit arrives as its own detached frame with the old token.
  expect(invokeFrom({ frameToken: 'doc-2', detached: true }).isCurrent()).toBe(false)
  expect(invokeFrom(null).isCurrent()).toBe(false)
})

it('retires work when an error page replaces the document without did-navigate', () => {
  const { frame, sender, invokeFrom } = fakeWindow()
  const lifetime = invokeFrom().watchRetirement()

  sender.emit('dom-ready')
  sender.emit('did-fail-load')
  expect(lifetime.signal.aborted).toBe(false)

  frame.token = 'error-page'
  sender.emit('did-fail-load')
  expect(lifetime.signal.aborted).toBe(true)
  for (const event of [
    'did-fail-load',
    'dom-ready',
    'did-navigate',
    'render-process-gone',
    'destroyed'
  ]) {
    expect(sender.listenerCount(event)).toBe(0)
  }
})

it('delivers nothing to a page that replaced the requesting one', () => {
  const { frame, delivered, invokeFrom } = fakeWindow()
  const endpoint = invokeFrom()
  endpoint.send('channel', 1)
  frame.token = 'doc-2'
  endpoint.send('channel', 2)

  expect(delivered).toEqual([['channel', 1]])
})
